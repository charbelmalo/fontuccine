/**
 * engine/font-load.ts — resolve a font outline source into a ParsedFont + the
 * `wdth` axis, LAZILY.
 *
 * Size discipline (Phase-5 budget): opentype.js and the parser are pulled in via
 * DYNAMIC import here, so they never land in the base `.` bundle — they load only
 * when a font binary must actually be parsed (SVG/WebGL tiers). The VF tier can
 * be selected with just an injected `wdthAxis` and never triggers this path.
 *
 * The frozen `font/parser.ts` is CONSUMED, not modified (CLAUDE.md). It gives us
 * outlines (`.glyph`) and kerning (`.kernPair`); it does not surface `fvar` or
 * blank-glyph advances, so we additionally read those structurally off a raw
 * opentype parse of the SAME bytes (`getWdthAxis`, `advanceOf`). Parsing twice is
 * a one-time, off-hot-path cost.
 */
import type { ParsedFont } from '../font/parser.ts';
import type { WdthAxis } from '../vf/detect.ts';
import { getWdthAxis } from '../vf/detect.ts';
import type { FontSource } from './types.ts';

export interface LoadedFont {
  parsed: ParsedFont;
  wdthAxis: WdthAxis | null;
  /** Advance (font units) for any char, including blanks — undefined when only a
   *  pre-parsed ParsedFont was supplied (no raw font to read blank advances). */
  advanceOf?: (char: string) => number;
  /** The sfnt bytes the outlines came from (WOFF already unpacked) — the width
   *  ladder instances further wdth/XTRA locations from them. Absent for an
   *  injected ParsedFont. */
  buffer?: ArrayBuffer;
}

/** Variable-font axis request (user units), e.g. `{ wght: 700, opsz: 128 }`. */
export type VariationRequest = Record<string, number>;

export const WOFF2_UNSUPPORTED_MESSAGE =
  'fontuccine: WOFF2 fonts are not supported by the bundled parser (opentype.js). ' +
  'Pass a .ttf/.otf/.woff URL or a decompressed ArrayBuffer via fontBuffer.';

/**
 * True when the binary starts with the WOFF2 signature 'wOF2' (0x77 0x4F 0x46
 * 0x32). opentype.js 1.3.4 reads TrueType (0x00010000/'true'), CFF ('OTTO') and
 * WOFF 1 ('wOFF', inflated internally — supported, passes through), but NOT
 * WOFF2 (Brotli + transformed glyf/loca): it would fail deep inside with
 * "Unsupported OpenType signature wOF2", so we reject it up front instead.
 */
export function isWoff2(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const b = new Uint8Array(buffer, 0, 4);
  return b[0] === 0x77 && b[1] === 0x4f && b[2] === 0x46 && b[3] === 0x32;
}

function toArrayBuffer(view: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (view instanceof ArrayBuffer) return view;
  const v = view as ArrayBufferView;
  return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
}

function resolveSource(cfg: {
  font?: FontSource;
  fontUrl?: string;
  fontBuffer?: ArrayBuffer | ArrayBufferView;
  parsedFont?: ParsedFont;
  wdthAxis?: WdthAxis | null;
}): FontSource | null {
  if (cfg.font) return cfg.font;
  if (cfg.parsedFont) return { parsed: cfg.parsedFont, wdthAxis: cfg.wdthAxis ?? null };
  if (cfg.fontBuffer) return { buffer: cfg.fontBuffer };
  if (cfg.fontUrl) return { url: cfg.fontUrl };
  return null;
}

export async function loadEngineFont(
  cfg: {
    font?: FontSource;
    fontUrl?: string;
    fontBuffer?: ArrayBuffer | ArrayBufferView;
    parsedFont?: ParsedFont;
    wdthAxis?: WdthAxis | null;
    unitsPerEm?: number;
    /** Instance the outlines at these axes (see `font/variation.ts`). */
    variations?: VariationRequest;
  },
): Promise<LoadedFont> {
  const src = resolveSource(cfg);
  if (!src) {
    throw new Error(
      'fontuccine: no font source. The SVG/WebGL tiers need outlines — pass ' +
        '`fontUrl`, `fontBuffer`, or `parsedFont` in the config.',
    );
  }
  const unitsPerEm = cfg.unitsPerEm ?? 1000;

  // Pre-parsed injection (advanced / tests): no raw bytes to read blanks from.
  if ('parsed' in src) {
    return { parsed: src.parsed, wdthAxis: src.wdthAxis ?? null };
  }

  let buffer =
    'buffer' in src
      ? toArrayBuffer(src.buffer)
      : await fetch(src.url).then(async (r) => {
          if (!r.ok) throw new Error(`fontuccine: font fetch failed (${r.status}) for ${src.url}`);
          const buf = await r.arrayBuffer();
          // Dev servers answer a missing file with `200 text/html` (their
          // index.html), which would otherwise fail deep in the parser as
          // "Unsupported OpenType signature <!do". Name the real problem.
          const type = r.headers?.get?.('content-type') ?? '';
          const firstByte = buf.byteLength > 0 ? new Uint8Array(buf, 0, 1)[0] : -1;
          if (type.includes('text/html') || firstByte === 0x3c) {
            throw new Error(`fontuccine: fontUrl did not return a font (got HTML — wrong path?) for ${src.url}`);
          }
          return buf;
        });

  // Lazy: opentype.js + the parser load ONLY here (dynamic import → own chunk).
  const [{ parseFont, FontUnavailableError }, otMod, { isWoff, unpackWoff }] = await Promise.all([
    import('../font/parser.ts'),
    import('opentype.js'),
    import('../font/variation.ts'),
  ]);
  const opentype = (otMod as { default?: unknown }).default ?? otMod;

  // Reject formats opentype.js cannot read with a clear, actionable error
  // (the frozen parser is consumed as-is; its error class is reused).
  if (isWoff2(buffer)) throw new FontUnavailableError(WOFF2_UNSUPPORTED_MESSAGE);

  // WOFF 1: repack as a plain sfnt so the variation tables are readable for
  // instancing (opentype.js inflates internally but keeps nothing we can use).
  // Without DecompressionStream the WOFF goes to opentype.js as-is (default
  // instance; the parser reports `unsupported-container`).
  if (isWoff(buffer)) {
    try {
      buffer = await unpackWoff(buffer);
    } catch {
      /* fall through with the original container */
    }
  }

  const parsed = parseFont(buffer, {
    fontSize: unitsPerEm,
    ...(cfg.variations ? { variations: cfg.variations } : {}),
  });

  // Raw parse for fvar (wdth) + blank-glyph advances (parser omits both).
  let wdthAxis: WdthAxis | null = cfg.wdthAxis ?? null;
  let advanceOf: ((char: string) => number) | undefined;
  try {
    const otFont = (opentype as { parse(b: ArrayBuffer): unknown }).parse(buffer) as {
      unitsPerEm: number;
      tables?: { fvar?: { axes?: Array<{ tag: string; minValue: number; defaultValue: number; maxValue: number }> } };
      charToGlyph(ch: string): { advanceWidth?: number } | null;
    };
    if (wdthAxis === undefined || wdthAxis === null) wdthAxis = getWdthAxis(otFont);
    const scale = unitsPerEm / otFont.unitsPerEm;
    advanceOf = (char: string): number => {
      // Instanced advance when the parser has one (blanks vary with wdth/wght too).
      if (parsed.advance) return parsed.advance(char);
      const g = otFont.charToGlyph(char);
      return (g?.advanceWidth ?? 0) * scale;
    };
  } catch {
    /* fvar/advance extraction is best-effort; outlines already succeeded */
  }

  return { parsed, wdthAxis, buffer, ...(advanceOf ? { advanceOf } : {}) };
}
