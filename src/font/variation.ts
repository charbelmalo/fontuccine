/**
 * font/variation.ts — variable-font instancing for TrueType-flavoured fonts
 * (`glyf` + `gvar`), written directly against the OpenType spec so the SVG and
 * WebGL tiers can render the SAME design instance the browser renders for the
 * element's computed `font-weight` / `font-stretch` / `font-optical-sizing` /
 * `font-variation-settings`.
 *
 * Why not a library: opentype.js 1.3.4 (already a dependency) parses `fvar`
 * but applies neither `gvar` nor `avar`, so every variable font rendered
 * through it comes out as the file's DEFAULT instance (Roboto Flex → thin
 * Regular under a `font-weight: 700` heading). fontkit (~300 kB + Buffer
 * polyfills) and harfbuzzjs (~1 MB WASM) both solve it at a bundle cost that
 * dwarfs this whole library; the delta math below is ~450 lines and lands in
 * the lazy font chunk (see size numbers in README.md).
 *
 * What is implemented (spec-complete for glyf fonts):
 *   • sfnt + WOFF1 table directories (`unpackWoff` inflates compressed WOFF
 *     tables with the platform DecompressionStream)
 *   • fvar axis records, avar v1 segment maps, F2Dot14 normalisation
 *   • gvar: shared/embedded peak tuples, intermediate regions, shared and
 *     private packed point numbers, packed deltas, region scalars
 *   • IUP (inferred untouched points) per contour, phantom points as
 *     single-point contours (advance width comes from the phantom span)
 *   • composite glyphs (deltas move component offsets; components recurse)
 * NOT implemented (falls back to the default instance with a reason):
 *   • CFF2 (`OTTO` with a CFF2 table) — no `glyf`, deltas live in CFF2 blends
 *   • GPOS/GDEF variation stores — kerning stays at default-instance values
 *   • `cvar` hinting deltas (irrelevant: outlines are rendered unhinted)
 */

export interface VariationAxis {
  tag: string;
  min: number;
  default: number;
  max: number;
}

/** A parsed `gvar` table (glyph variation data stays as a DataView). */
export interface GvarTable {
  axisCount: number;
  sharedTuples: Float64Array;
  glyphCount: number;
  /** Absolute byte offset of each glyph's variation data (length glyphCount+1). */
  offsets: Uint32Array;
  view: DataView;
}

export type AvarMap = Array<Array<[number, number]>>;

export interface VariationTables {
  axes: VariationAxis[];
  avar: AvarMap | null;
  gvar: GvarTable | null;
  outlines: 'glyf' | 'cff' | 'cff2' | 'unknown';
}

export interface Pt {
  x: number;
  y: number;
}

export interface GlyphDeltas {
  /** Per real point + 4 phantom points (dx[n..n+3]). */
  dx: Float64Array;
  dy: Float64Array;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table directory
// ─────────────────────────────────────────────────────────────────────────────

function tagAt(v: DataView, off: number): string {
  return String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
}

interface TableRecord {
  tag: string;
  offset: number;
  length: number;
  compLength: number;
}

function readDirectory(buffer: ArrayBuffer): { kind: 'sfnt' | 'woff' | 'unsupported'; tables: TableRecord[] } {
  const v = new DataView(buffer);
  if (buffer.byteLength < 12) return { kind: 'unsupported', tables: [] };
  const sig = v.getUint32(0);
  const tag = tagAt(v, 0);
  const tables: TableRecord[] = [];
  if (sig === 0x00010000 || tag === 'true' || tag === 'OTTO') {
    const numTables = v.getUint16(4);
    for (let i = 0; i < numTables; i++) {
      const o = 12 + i * 16;
      if (o + 16 > buffer.byteLength) break;
      const length = v.getUint32(o + 12);
      tables.push({ tag: tagAt(v, o), offset: v.getUint32(o + 8), length, compLength: length });
    }
    return { kind: 'sfnt', tables };
  }
  if (tag === 'wOFF') {
    const numTables = v.getUint16(12);
    for (let i = 0; i < numTables; i++) {
      const o = 44 + i * 20;
      if (o + 20 > buffer.byteLength) break;
      tables.push({
        tag: tagAt(v, o),
        offset: v.getUint32(o + 4),
        compLength: v.getUint32(o + 8),
        length: v.getUint32(o + 12),
      });
    }
    return { kind: 'woff', tables };
  }
  return { kind: 'unsupported', tables: [] };
}

/** True when the buffer is a WOFF 1 container ('wOFF'). */
export function isWoff(buffer: ArrayBuffer): boolean {
  return buffer.byteLength >= 4 && tagAt(new DataView(buffer), 0) === 'wOFF';
}

/**
 * Repack a WOFF 1 container as a plain sfnt (inflating zlib-compressed tables
 * with the platform `DecompressionStream`). Both opentype.js and the instancer
 * then read the same plain bytes. Throws when no DecompressionStream exists.
 */
export async function unpackWoff(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const dir = readDirectory(buffer);
  if (dir.kind !== 'woff') return buffer;
  const v = new DataView(buffer);
  const flavor = v.getUint32(4);
  const n = dir.tables.length;
  const datas: Uint8Array[] = [];
  for (const t of dir.tables) {
    const raw = new Uint8Array(buffer, t.offset, t.compLength);
    datas.push(t.compLength === t.length ? raw : await inflate(raw, t.length));
  }
  let total = 12 + 16 * n;
  const offsets: number[] = [];
  for (const d of datas) {
    offsets.push(total);
    total += (d.length + 3) & ~3;
  }
  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, flavor);
  ov.setUint16(4, n);
  let es = 1, sr = 0;
  while (es * 2 <= n) { es *= 2; sr++; }
  ov.setUint16(6, es * 16);
  ov.setUint16(8, sr);
  ov.setUint16(10, n * 16 - es * 16);
  dir.tables.forEach((t, i) => {
    const o = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[o + k] = t.tag.charCodeAt(k);
    ov.setUint32(o + 4, 0);
    ov.setUint32(o + 8, offsets[i]!);
    ov.setUint32(o + 12, datas[i]!.length);
    out.set(datas[i]!, offsets[i]!);
  });
  return out.buffer;
}

async function inflate(data: Uint8Array, expected: number): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!DS) throw new Error('fontuccine: compressed WOFF needs DecompressionStream');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DS('deflate'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  if (buf.length !== expected) throw new Error('fontuccine: WOFF table inflated to an unexpected size');
  return buf;
}

// ─────────────────────────────────────────────────────────────────────────────
// fvar / avar / gvar
// ─────────────────────────────────────────────────────────────────────────────

function f2dot14(v: DataView, off: number): number {
  return v.getInt16(off) / 16384;
}

function parseFvar(v: DataView, base: number): VariationAxis[] {
  const axesOffset = v.getUint16(base + 4);
  const axisCount = v.getUint16(base + 8);
  const axisSize = v.getUint16(base + 10);
  const axes: VariationAxis[] = [];
  for (let i = 0; i < axisCount; i++) {
    const o = base + axesOffset + i * axisSize;
    axes.push({
      tag: tagAt(v, o),
      min: v.getInt32(o + 4) / 65536,
      default: v.getInt32(o + 8) / 65536,
      max: v.getInt32(o + 12) / 65536,
    });
  }
  return axes;
}

function parseAvar(v: DataView, base: number, axisCount: number): AvarMap | null {
  const major = v.getUint16(base);
  if (major !== 1 && major !== 2) return null; // v2 keeps the v1 segment maps up front
  const count = v.getUint16(base + 6);
  if (count !== axisCount) return null;
  const maps: AvarMap = [];
  let p = base + 8;
  for (let i = 0; i < axisCount; i++) {
    const n = v.getUint16(p);
    p += 2;
    const seg: Array<[number, number]> = [];
    for (let k = 0; k < n; k++) {
      seg.push([f2dot14(v, p), f2dot14(v, p + 2)]);
      p += 4;
    }
    maps.push(seg);
  }
  return maps;
}

function parseGvar(v: DataView, base: number): GvarTable {
  const axisCount = v.getUint16(base + 4);
  const sharedTupleCount = v.getUint16(base + 6);
  const sharedTuplesOffset = v.getUint32(base + 8);
  const glyphCount = v.getUint16(base + 12);
  const flags = v.getUint16(base + 14);
  const dataArrayOffset = v.getUint32(base + 16);
  const sharedTuples = new Float64Array(sharedTupleCount * axisCount);
  for (let i = 0; i < sharedTuples.length; i++) sharedTuples[i] = f2dot14(v, base + sharedTuplesOffset + i * 2);
  const offsets = new Uint32Array(glyphCount + 1);
  const longOffsets = (flags & 1) !== 0;
  for (let i = 0; i <= glyphCount; i++) {
    const o = base + 20 + i * (longOffsets ? 4 : 2);
    offsets[i] = base + dataArrayOffset + (longOffsets ? v.getUint32(o) : v.getUint16(o) * 2);
  }
  return { axisCount, sharedTuples, glyphCount, offsets, view: v };
}

/**
 * Read the variation tables of a font binary (sfnt or uncompressed WOFF).
 * Returns null when the font has no `fvar` (static font).
 */
export function readVariationTables(buffer: ArrayBuffer): VariationTables | null {
  const dir = readDirectory(buffer);
  if (dir.kind === 'unsupported') return null;
  const find = (tag: string) => dir.tables.find((t) => t.tag === tag);
  const fvar = find('fvar');
  if (!fvar) return null;
  const v = new DataView(buffer);
  const usable = (t: TableRecord | undefined) =>
    !!t && t.compLength === t.length && t.offset + t.length <= buffer.byteLength;
  if (!usable(fvar)) return null;
  const axes = parseFvar(v, fvar!.offset);
  const avarRec = find('avar');
  const gvarRec = find('gvar');
  const avar = usable(avarRec) ? parseAvar(v, avarRec!.offset, axes.length) : null;
  const gvar = usable(gvarRec) ? parseGvar(v, gvarRec!.offset) : null;
  const outlines: VariationTables['outlines'] = find('glyf')
    ? 'glyf'
    : find('CFF2')
      ? 'cff2'
      : find('CFF ')
        ? 'cff'
        : 'unknown';
  return { axes, avar, gvar, outlines };
}

// ─────────────────────────────────────────────────────────────────────────────
// Axis normalisation
// ─────────────────────────────────────────────────────────────────────────────

function piecewiseLinear(map: Array<[number, number]>, v: number): number {
  if (map.length === 0) return v;
  let lo = map[0]!;
  if (v <= lo[0]) return lo[1];
  for (let i = 1; i < map.length; i++) {
    const hi = map[i]!;
    if (v === hi[0]) return hi[1];
    if (v < hi[0]) {
      const t = (v - lo[0]) / (hi[0] - lo[0]);
      return lo[1] + t * (hi[1] - lo[1]);
    }
    lo = hi;
  }
  return lo[1];
}

/**
 * User-space axis request → normalised [-1, 1] coordinates in fvar axis order
 * (clamped to the designed range, avar-mapped, rounded to F2Dot14 like every
 * shaping engine does). Unknown tags in `request` are ignored.
 */
export function normalizeCoords(
  tables: Pick<VariationTables, 'axes' | 'avar'>,
  request: Readonly<Record<string, number>>,
): Float64Array {
  const out = new Float64Array(tables.axes.length);
  tables.axes.forEach((axis, i) => {
    const raw = request[axis.tag];
    let v = raw != null && Number.isFinite(raw) ? raw : axis.default;
    v = Math.min(axis.max, Math.max(axis.min, v));
    let n = 0;
    if (v < axis.default && axis.default > axis.min) n = (v - axis.default) / (axis.default - axis.min);
    else if (v > axis.default && axis.max > axis.default) n = (v - axis.default) / (axis.max - axis.default);
    if (tables.avar?.[i]) n = piecewiseLinear(tables.avar[i]!, n);
    n = Math.max(-1, Math.min(1, n));
    out[i] = Math.round(n * 16384) / 16384;
  });
  return out;
}

/** True when every normalised coordinate is 0 (the default instance). */
export function isDefaultLocation(coords: Float64Array): boolean {
  for (let i = 0; i < coords.length; i++) if (coords[i] !== 0) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// gvar glyph deltas
// ─────────────────────────────────────────────────────────────────────────────

const EMBEDDED_PEAK_TUPLE = 0x8000;
const INTERMEDIATE_REGION = 0x4000;
const PRIVATE_POINT_NUMBERS = 0x2000;
const TUPLE_INDEX_MASK = 0x0fff;
const SHARED_POINT_NUMBERS = 0x8000;
const COUNT_MASK = 0x0fff;

interface Cursor {
  p: number;
}

/** Packed point numbers → array of point indices, or null for "all points". */
function readPackedPoints(v: DataView, c: Cursor): Uint16Array | null {
  let b = v.getUint8(c.p++);
  let count: number;
  if (b === 0) return null;
  if (b & 0x80) count = ((b & 0x7f) << 8) | v.getUint8(c.p++);
  else count = b;
  const out = new Uint16Array(count);
  let i = 0;
  let acc = 0;
  while (i < count) {
    b = v.getUint8(c.p++);
    const words = (b & 0x80) !== 0;
    const run = (b & 0x7f) + 1;
    for (let k = 0; k < run && i < count; k++) {
      if (words) {
        acc += v.getUint16(c.p);
        c.p += 2;
      } else {
        acc += v.getUint8(c.p++);
      }
      out[i++] = acc;
    }
  }
  return out;
}

/** Packed deltas → `count` numbers. */
function readPackedDeltas(v: DataView, c: Cursor, count: number, out: Float64Array, offset: number): void {
  let i = 0;
  while (i < count) {
    const b = v.getUint8(c.p++);
    const run = (b & 0x3f) + 1;
    if (b & 0x80) {
      for (let k = 0; k < run && i < count; k++) out[offset + i++] = 0;
    } else if (b & 0x40) {
      for (let k = 0; k < run && i < count; k++) {
        out[offset + i++] = v.getInt16(c.p);
        c.p += 2;
      }
    } else {
      for (let k = 0; k < run && i < count; k++) out[offset + i++] = v.getInt8(c.p++);
    }
  }
}

/** Region scalar for one tuple at the requested normalised location. */
function tupleScalar(
  coords: Float64Array,
  peak: ArrayLike<number>,
  peakOff: number,
  start: Float64Array | null,
  end: Float64Array | null,
): number {
  let s = 1;
  for (let a = 0; a < coords.length; a++) {
    const pk = peak[peakOff + a]!;
    if (pk === 0) continue;
    const v = coords[a]!;
    if (v === pk) continue;
    let lo: number, hi: number;
    if (start && end) {
      lo = start[a]!;
      hi = end[a]!;
      if (lo > pk || pk > hi || (lo < 0 && hi > 0 && pk !== 0)) continue; // invalid region: spec says ignore axis
    } else {
      lo = Math.min(0, pk);
      hi = Math.max(0, pk);
    }
    if (v <= lo || hi <= v) return 0;
    if (v < pk) s *= (v - lo) / (pk - lo);
    else s *= (hi - v) / (hi - pk);
  }
  return s;
}

/** IUP for one coordinate dimension of one contour segment (fontTools semantics). */
function iupSegment(c: number, c1: number, c2: number, d1: number, d2: number): number {
  if (c1 === c2) return d1 === d2 ? d1 : 0;
  if (c1 > c2) {
    const tc = c1; c1 = c2; c2 = tc;
    const td = d1; d1 = d2; d2 = td;
  }
  if (c <= c1) return d1;
  if (c >= c2) return d2;
  return d1 + ((c - c1) * (d2 - d1)) / (c2 - c1);
}

/**
 * Infer deltas for untouched points, contour by contour, from the default
 * coordinates (`xs`/`ys`) and the touched neighbours (cyclic within a contour).
 * `ends` holds the last point index of each contour (real points only); the 4
 * phantom points are single-point contours (untouched ⇒ 0).
 */
function inferUntouched(
  dx: Float64Array,
  dy: Float64Array,
  touched: Uint8Array,
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  ends: ArrayLike<number>,
): void {
  let start = 0;
  for (let ci = 0; ci < ends.length; ci++) {
    const end = ends[ci]!;
    const n = end - start + 1;
    if (n <= 0) continue;
    const idx: number[] = [];
    for (let i = start; i <= end; i++) if (touched[i]) idx.push(i);
    if (idx.length === 0 || idx.length === n) {
      start = end + 1;
      continue;
    }
    for (let k = 0; k < idx.length; k++) {
      const r1 = idx[k]!;
      const r2 = idx[(k + 1) % idx.length]!;
      // walk the untouched points strictly between r1 and r2 (cyclic)
      let i = r1 + 1 > end ? start : r1 + 1;
      while (i !== r2) {
        dx[i] = iupSegment(xs[i]!, xs[r1]!, xs[r2]!, dx[r1]!, dx[r2]!);
        dy[i] = iupSegment(ys[i]!, ys[r1]!, ys[r2]!, dy[r1]!, dy[r2]!);
        i = i + 1 > end ? start : i + 1;
      }
    }
    start = end + 1;
  }
}

/**
 * Accumulated gvar deltas for one glyph at `coords`. `points` are the glyph's
 * DEFAULT coordinates (real points only; for a composite, one per component),
 * `ends` the contour end indices (for a composite, every component is its own
 * contour). Returns null when the glyph has no variation data.
 */
export function glyphDeltas(
  gvar: GvarTable,
  glyphIndex: number,
  coords: Float64Array,
  points: ReadonlyArray<Pt>,
  ends: ArrayLike<number>,
): GlyphDeltas | null {
  if (glyphIndex < 0 || glyphIndex >= gvar.glyphCount) return null;
  const from = gvar.offsets[glyphIndex]!;
  const to = gvar.offsets[glyphIndex + 1]!;
  if (to <= from) return null;
  const v = gvar.view;
  const axisCount = gvar.axisCount;
  const n = points.length;
  const total = n + 4;
  const xs = new Float64Array(total);
  const ys = new Float64Array(total);
  for (let i = 0; i < n; i++) {
    xs[i] = points[i]!.x;
    ys[i] = points[i]!.y;
  }
  const phantomEnds = new Float64Array(ends.length + 4);
  for (let i = 0; i < ends.length; i++) phantomEnds[i] = ends[i]!;
  for (let k = 0; k < 4; k++) phantomEnds[ends.length + k] = n + k;

  const tupleCountRaw = v.getUint16(from);
  const tupleCount = tupleCountRaw & COUNT_MASK;
  const dataStart = from + v.getUint16(from + 2);
  const hdr: Cursor = { p: from + 4 };
  const data: Cursor = { p: dataStart };
  let sharedPoints: Uint16Array | null = null;
  let sharedAll = false;
  if (tupleCountRaw & SHARED_POINT_NUMBERS) {
    sharedPoints = readPackedPoints(v, data);
    sharedAll = sharedPoints === null;
  }

  const outX = new Float64Array(total);
  const outY = new Float64Array(total);
  const tmpX = new Float64Array(total);
  const tmpY = new Float64Array(total);
  const touched = new Uint8Array(total);
  const peakBuf = new Float64Array(axisCount);
  const startBuf = new Float64Array(axisCount);
  const endBuf = new Float64Array(axisCount);
  let any = false;

  for (let t = 0; t < tupleCount; t++) {
    const size = v.getUint16(hdr.p);
    const tupleIndex = v.getUint16(hdr.p + 2);
    hdr.p += 4;
    let peak: ArrayLike<number>;
    let peakOff: number;
    if (tupleIndex & EMBEDDED_PEAK_TUPLE) {
      for (let a = 0; a < axisCount; a++) peakBuf[a] = f2dot14(v, hdr.p + a * 2);
      hdr.p += axisCount * 2;
      peak = peakBuf;
      peakOff = 0;
    } else {
      peak = gvar.sharedTuples;
      peakOff = (tupleIndex & TUPLE_INDEX_MASK) * axisCount;
    }
    let start: Float64Array | null = null;
    let end: Float64Array | null = null;
    if (tupleIndex & INTERMEDIATE_REGION) {
      for (let a = 0; a < axisCount; a++) {
        startBuf[a] = f2dot14(v, hdr.p + a * 2);
        endBuf[a] = f2dot14(v, hdr.p + (axisCount + a) * 2);
      }
      hdr.p += axisCount * 4;
      start = startBuf;
      end = endBuf;
    }
    const scalar = tupleScalar(coords, peak, peakOff, start, end);
    const tupleData = data.p;
    data.p += size;
    if (scalar === 0) continue;

    const c: Cursor = { p: tupleData };
    let pts: Uint16Array | null;
    let all: boolean;
    if (tupleIndex & PRIVATE_POINT_NUMBERS) {
      pts = readPackedPoints(v, c);
      all = pts === null;
    } else {
      pts = sharedPoints;
      all = sharedAll || (!(tupleCountRaw & SHARED_POINT_NUMBERS));
    }
    if (all) {
      readPackedDeltas(v, c, total, tmpX, 0);
      readPackedDeltas(v, c, total, tmpY, 0);
      for (let i = 0; i < total; i++) {
        outX[i] += scalar * tmpX[i]!;
        outY[i] += scalar * tmpY[i]!;
      }
    } else {
      const count = pts!.length;
      const dxs = new Float64Array(count);
      const dys = new Float64Array(count);
      readPackedDeltas(v, c, count, dxs, 0);
      readPackedDeltas(v, c, count, dys, 0);
      tmpX.fill(0);
      tmpY.fill(0);
      touched.fill(0);
      for (let k = 0; k < count; k++) {
        const i = pts![k]!;
        if (i >= total) continue;
        tmpX[i] = dxs[k]!;
        tmpY[i] = dys[k]!;
        touched[i] = 1;
      }
      inferUntouched(tmpX, tmpY, touched, xs, ys, phantomEnds);
      for (let i = 0; i < total; i++) {
        outX[i] += scalar * tmpX[i]!;
        outY[i] += scalar * tmpY[i]!;
      }
    }
    any = true;
  }
  return any ? { dx: outX, dy: outY } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Instancer bound to one font binary
// ─────────────────────────────────────────────────────────────────────────────

export interface Instancer {
  readonly axes: VariationAxis[];
  /** Normalised coordinates of the bound request. */
  readonly coords: Float64Array;
  /** True when the request differs from the default instance. */
  readonly active: boolean;
  /** The user-space location actually applied (clamped, defaults filled in). */
  readonly location: Record<string, number>;
  /** Deltas for one glyph, or null. */
  deltas(glyphIndex: number, points: ReadonlyArray<Pt>, ends: ArrayLike<number>): GlyphDeltas | null;
}

export type InstancerResult =
  | { ok: true; instancer: Instancer }
  | { ok: false; reason: 'not-variable' | 'no-gvar' | 'cff2-unsupported' | 'unsupported-container' };

/**
 * Bind a variation request (e.g. `{ wght: 700, opsz: 128 }`) to a font binary.
 * Returns a reason instead of an instancer when the font cannot be instanced.
 */
export function createInstancer(buffer: ArrayBuffer, request: Readonly<Record<string, number>>): InstancerResult {
  const dir = readDirectory(buffer);
  if (dir.kind === 'unsupported') return { ok: false, reason: 'unsupported-container' };
  const tables = readVariationTables(buffer);
  if (!tables) return { ok: false, reason: 'not-variable' };
  if (tables.outlines === 'cff2') return { ok: false, reason: 'cff2-unsupported' };
  if (!tables.gvar) return { ok: false, reason: 'no-gvar' };
  const coords = normalizeCoords(tables, request);
  const gvar = tables.gvar;
  const location: Record<string, number> = {};
  for (const a of tables.axes) {
    const raw = request[a.tag];
    const v = raw != null && Number.isFinite(raw) ? raw : a.default;
    location[a.tag] = Math.min(a.max, Math.max(a.min, v));
  }
  return {
    ok: true,
    instancer: {
      axes: tables.axes,
      coords,
      active: !isDefaultLocation(coords),
      location,
      deltas: (glyphIndex, points, ends) => glyphDeltas(gvar, glyphIndex, coords, points, ends),
    },
  };
}
