/**
 * Ink calibration — match the host's native text rasteriser.
 *
 * Browsers do not draw text with plain coverage anti-aliasing. Skia applies a
 * luminance-dependent contrast boost to glyph masks and, on macOS at DPR 1,
 * CoreText "font smoothing" dilates every edge; the WebGL (MSDF) and SVG tiers
 * fill the exact outline instead, so at rest they read visibly lighter than the
 * native text they replace. Measured on Chrome 141 / macOS, Roboto Flex 700:
 *   DPR 1: native text is +0.53 px per edge bolder than the outline (≈ 8 % more
 *          ink, stems 15 px vs 14 px); 0.00 px with
 *          `-webkit-font-smoothing: antialiased`.
 *   DPR 2: +0.36 device px per edge (the smoothing property has no effect).
 * Canvas `fillText` goes through the same rasteriser (measured within 0.02 px
 * of the DOM text), so ONE offscreen probe — the host's own glyphs drawn once as
 * text and once as their outline — measures the dilation for this exact
 * font / size / colour / DPR. The tiers then dilate their ink by that amount
 * (MSDF: a distance-threshold shift; SVG: a same-colour stroke).
 *
 * Limits: the probe can only be drawn when the canvas font shorthand can
 * express the element's instance (numeric weight, keyword stretch, normal
 * `font-variation-settings`, `font-optical-sizing: auto`); otherwise it reports
 * `null` and the tiers render the plain outline. Negative dilation (a rasteriser
 * thinner than the outline) is applied by the MSDF tier only — SVG cannot erode.
 */
import type { PathCommand } from '../core/types.ts';

export interface ProbeGlyph {
  /** Outline in font units, y-down (opentype `getPath(0, 0, upm)` convention). */
  commands: PathCommand[];
  advanceWidth: number;
}

export interface InkProbeInput {
  doc: Document;
  /** Computed CSS values of the host. */
  fontFamily: string;
  fontWeight: string;
  fontStretch: string;
  fontStyle: string;
  fontSizePx: number;
  fontVariationSettings?: string;
  fontOpticalSizing?: string;
  /** Computed `-webkit-font-smoothing` (macOS only; '' / undefined elsewhere). */
  fontSmoothing?: string;
  /** Ink colour as CSS `rgb()`/`rgba()` (alpha ignored). */
  color: string;
  dpr: number;
  /** Probe glyphs (the host's own outlines) + the characters they draw. */
  glyphs: { char: string; glyph: ProbeGlyph }[];
  unitsPerEm: number;
}

export interface InkCalibration {
  /** Extra ink per edge, in DEVICE px (negative ⇒ rasteriser thinner than outline). */
  dilationDevicePx: number;
  /** Same, in CSS px. */
  dilationCssPx: number;
  /** How the value was obtained. */
  source: 'probe' | 'smoothing-rule' | 'cache';
}

/** Largest |dilation| the tiers will apply (device px per edge). Synthetic bold
 *  (browser-faked weight for a static font) measures beyond this and is capped. */
export const MAX_INK_DILATION = 1.5;

const STRETCH_KEYWORDS: [number, string][] = [
  [50, 'ultra-condensed'], [62.5, 'extra-condensed'], [75, 'condensed'], [87.5, 'semi-condensed'],
  [100, 'normal'], [112.5, 'semi-expanded'], [125, 'expanded'], [150, 'extra-expanded'], [200, 'ultra-expanded'],
];

/** Map a computed `font-stretch` to the canvas keyword, or null when none matches (±0.5 %). */
export function stretchKeyword(fontStretch: string): string | null {
  const s = fontStretch.trim();
  if (s === '' || s === 'normal') return 'normal';
  for (const [, kw] of STRETCH_KEYWORDS) if (s === kw) return kw;
  const pct = s.endsWith('%') ? Number(s.slice(0, -1)) : Number.NaN;
  if (!Number.isFinite(pct)) return null;
  for (const [p, kw] of STRETCH_KEYWORDS) if (Math.abs(p - pct) <= 0.5) return kw;
  return null;
}

/** Parse `rgb()` / `rgba()` / `#rrggbb` into 0..255 channels (alpha dropped). */
export function parseInkColor(css: string): [number, number, number] | null {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (h) return [parseInt(h[1]!.slice(0, 2), 16), parseInt(h[1]!.slice(2, 4), 16), parseInt(h[1]!.slice(4, 6), 16)];
  return null;
}

/** Outline perimeter in font units (curves flattened to 8 segments). */
export function outlinePerimeter(commands: PathCommand[]): number {
  let total = 0;
  let sx = 0, sy = 0, cx = 0, cy = 0;
  const seg = (x: number, y: number): void => {
    total += Math.hypot(x - cx, y - cy);
    cx = x; cy = y;
  };
  for (const c of commands) {
    switch (c.type) {
      case 'M': cx = sx = c.x ?? 0; cy = sy = c.y ?? 0; break;
      case 'L': seg(c.x ?? cx, c.y ?? cy); break;
      case 'Q': {
        const x0 = cx, y0 = cy, x1 = c.x1 ?? cx, y1 = c.y1 ?? cy, x2 = c.x ?? cx, y2 = c.y ?? cy;
        for (let i = 1; i <= 8; i++) {
          const t = i / 8, u = 1 - t;
          seg(u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2);
        }
        break;
      }
      case 'C': {
        const x0 = cx, y0 = cy, x1 = c.x1 ?? cx, y1 = c.y1 ?? cy, x2 = c.x2 ?? cx, y2 = c.y2 ?? cy, x3 = c.x ?? cx, y3 = c.y ?? cy;
        for (let i = 1; i <= 8; i++) {
          const t = i / 8, u = 1 - t;
          seg(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
              u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
        }
        break;
      }
      case 'Z': seg(sx, sy); break;
    }
  }
  return total;
}

/** Sum of per-pixel coverage of `ink` over `bg` in an RGBA buffer (0..1 per px). */
export function coverageSum(data: Uint8ClampedArray, ink: [number, number, number], bg: [number, number, number]): number {
  const vr = ink[0] - bg[0], vg = ink[1] - bg[1], vb = ink[2] - bg[2];
  const vv = vr * vr + vg * vg + vb * vb || 1;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const c = ((data[i]! - bg[0]) * vr + (data[i + 1]! - bg[1]) * vg + (data[i + 2]! - bg[2]) * vb) / vv;
    sum += c < 0 ? 0 : c > 1 ? 1 : c;
  }
  return sum;
}

/** Append outline commands (font units, y-down) to a Path2D at px scale/offset. */
function outlineToPath2D(path: Path2D, commands: PathCommand[], scale: number, ox: number, oy: number): void {
  for (const c of commands) {
    switch (c.type) {
      case 'M': path.moveTo(ox + (c.x ?? 0) * scale, oy + (c.y ?? 0) * scale); break;
      case 'L': path.lineTo(ox + (c.x ?? 0) * scale, oy + (c.y ?? 0) * scale); break;
      case 'Q': path.quadraticCurveTo(ox + (c.x1 ?? 0) * scale, oy + (c.y1 ?? 0) * scale, ox + (c.x ?? 0) * scale, oy + (c.y ?? 0) * scale); break;
      case 'C': path.bezierCurveTo(ox + (c.x1 ?? 0) * scale, oy + (c.y1 ?? 0) * scale, ox + (c.x2 ?? 0) * scale, oy + (c.y2 ?? 0) * scale, ox + (c.x ?? 0) * scale, oy + (c.y ?? 0) * scale); break;
      case 'Z': path.closePath(); break;
    }
  }
}

const cache = new Map<string, InkCalibration | null>();

/** Test hook. */
export function __resetInkCalibrationCache(): void {
  cache.clear();
}

/** The canvas font shorthand for the host's instance, or null when inexpressible. */
export function canvasFontFor(input: Pick<InkProbeInput, 'fontFamily' | 'fontWeight' | 'fontStretch' | 'fontStyle' | 'fontSizePx' | 'fontVariationSettings' | 'fontOpticalSizing'>): { font: string; stretch: string } | null {
  const fvs = (input.fontVariationSettings ?? 'normal').trim();
  if (fvs !== '' && fvs !== 'normal') return null;
  if ((input.fontOpticalSizing ?? 'auto') === 'none') return null;
  const stretch = stretchKeyword(input.fontStretch);
  if (!stretch) return null;
  const style = input.fontStyle.trim() || 'normal';
  if (!/^(normal|italic|oblique(\s+-?[\d.]+deg)?)$/.test(style)) return null;
  const weight = input.fontWeight.trim() || '400';
  if (!/^(\d{1,4}|normal|bold)$/.test(weight)) return null;
  return { font: `${style} ${weight} ${input.fontSizePx}px ${input.fontFamily}`, stretch };
}

/**
 * Measure how much bolder the host's text rasteriser draws `glyphs` than their
 * outline. Resolves to null when the probe cannot run (no canvas 2D, font not
 * loadable, instance inexpressible, degenerate measurement).
 */
export async function measureInkDilation(input: InkProbeInput): Promise<InkCalibration | null> {
  const ink = parseInkColor(input.color);
  if (!ink) return null;
  const dpr = input.dpr > 0 ? input.dpr : 1;
  const key = [input.fontFamily, input.fontWeight, input.fontStretch, input.fontStyle, input.fontSizePx,
    input.fontVariationSettings ?? '', input.fontOpticalSizing ?? '', input.fontSmoothing ?? '', ink.join(','), dpr,
    input.glyphs.map((g) => g.char).join('')].join('|');
  const hit = cache.get(key);
  if (hit !== undefined) return hit ? { ...hit, source: 'cache' } : null;

  // macOS DPR 1 with `-webkit-font-smoothing: antialiased`: the DOM text has no
  // smoothing dilation (measured 0.00 px) but canvas text still does — the
  // property is not honoured by canvas — so the probe would over-report.
  if ((input.fontSmoothing ?? '') === 'antialiased' && dpr < 1.5) {
    const r: InkCalibration = { dilationDevicePx: 0, dilationCssPx: 0, source: 'smoothing-rule' };
    cache.set(key, r);
    return r;
  }

  const result = await runProbe(input, ink, dpr);
  cache.set(key, result);
  return result;
}

async function runProbe(input: InkProbeInput, ink: [number, number, number], dpr: number): Promise<InkCalibration | null> {
  const spec = canvasFontFor(input);
  if (!spec || input.glyphs.length === 0 || !(input.fontSizePx > 0)) return null;
  if (typeof Path2D === 'undefined') return null;
  const doc = input.doc;
  const canvas = doc.createElement('canvas');
  if (typeof canvas.getContext !== 'function') return null;

  // Make sure the CSS font is actually loaded for canvas (a fallback font would
  // measure a different outline, not a rasteriser).
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
  const probeText = input.glyphs.map((g) => g.char).join('');
  if (fonts) {
    try {
      if (!fonts.check(spec.font, probeText)) await fonts.load(spec.font, probeText);
      if (!fonts.check(spec.font, probeText)) return null;
    } catch {
      return null;
    }
  }

  const scale = (input.fontSizePx * dpr) / input.unitsPerEm; // font units → device px
  const gap = Math.ceil(input.fontSizePx * dpr * 0.25);
  const margin = Math.ceil(input.fontSizePx * dpr * 0.35);
  let width = margin;
  const xs: number[] = [];
  for (const { glyph } of input.glyphs) {
    xs.push(width);
    width += Math.ceil(glyph.advanceWidth * scale) + gap;
  }
  width += margin;
  const height = Math.ceil(input.fontSizePx * dpr * 1.7);
  if (width > 8192 || height > 8192) return null;
  const baseline = Math.round(input.fontSizePx * dpr * 1.25);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  // Opaque background of the opposite luminance: CoreText disables smoothing on
  // transparent layers, so an alpha-only probe would not see what DOM text gets.
  const lum = 0.2126 * ink[0] + 0.7152 * ink[1] + 0.0722 * ink[2];
  const bg: [number, number, number] = lum > 127 ? [0, 0, 0] : [255, 255, 255];
  const inkCss = `rgb(${ink[0]}, ${ink[1]}, ${ink[2]})`;
  const bgCss = `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`;

  const paintBg = (): void => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = bgCss;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = inkCss;
  };

  // 1) the browser's text rasteriser: one fillText per glyph (no kerning, no overlaps).
  paintBg();
  ctx.font = spec.font;
  try {
    (ctx as unknown as { fontStretch: string }).fontStretch = spec.stretch;
    (ctx as unknown as { fontKerning: string }).fontKerning = 'none';
  } catch {
    /* older canvas: attributes absent */
  }
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  input.glyphs.forEach(({ char }, i) => ctx.fillText(char, xs[i]! / dpr, baseline / dpr));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const textCov = coverageSum(ctx.getImageData(0, 0, width, height).data, ink, bg);

  // 2) the same outlines filled as paths (plain coverage AA, like the SVG tier).
  paintBg();
  const path = new Path2D();
  let perimeterUnits = 0;
  input.glyphs.forEach(({ glyph }, i) => {
    outlineToPath2D(path, glyph.commands, scale, xs[i]!, baseline);
    perimeterUnits += outlinePerimeter(glyph.commands);
  });
  ctx.fill(path, 'nonzero');
  const pathCov = coverageSum(ctx.getImageData(0, 0, width, height).data, ink, bg);

  const perimeterPx = perimeterUnits * scale;
  if (!(perimeterPx > 0) || !(pathCov > 0)) return null;
  // The canvas font may have fallen back to another family: then the two inks
  // differ by far more than any rasteriser could account for.
  const ratio = textCov / pathCov;
  if (!Number.isFinite(ratio) || ratio < 0.6 || ratio > 1.6) return null;
  let d = (textCov - pathCov) / perimeterPx;
  if (!Number.isFinite(d)) return null;
  d = Math.max(-MAX_INK_DILATION, Math.min(MAX_INK_DILATION, d));
  return { dilationDevicePx: d, dilationCssPx: d / dpr, source: 'probe' };
}
