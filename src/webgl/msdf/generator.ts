/**
 * webgl/msdf/generator.ts — runtime MULTI-CHANNEL signed distance field builder
 * for ARBITRARY outline fonts (troika-class), the Tier-1 analog of the static
 * flex analysis. Runs OFF the main thread (worker.ts) and NEVER per frame;
 * results are cached + LRU-evicted by the atlas.
 *
 * ── Why MSDF (3-channel), not single-channel SDF ──
 * A single-channel SDF stores distance-to-nearest-edge, so a sharp corner
 * becomes the max/min of two edges → a rounded arc. MSDF (Chlumsky/msdfgen)
 * colours edges so that at a corner the two edges live in DIFFERENT channels;
 * the per-pixel MEDIAN of the three channels reconstructs the corner as the
 * intersection of the two edge half-planes → sharp at any magnification. The
 * fragment shader takes `median(r,g,b)` exactly.
 *
 * ── What this file implements (msdfgen semantics, pure TS) ──
 *   1. edgeColoringSimple: corners by angle threshold in RADIANS (default 3,
 *      i.e. |sin θ| > sin 3 ≈ 0.141 or a reflex turn), colours cycle
 *      CYAN→MAGENTA→YELLOW with the "banned colour" rule so the last run of a
 *      contour never equals the first, and the single-corner (teardrop) case
 *      splits the edge into three colours.
 *   2. Signed pseudo-distance: TRUE distance selects the nearest edge per
 *      channel (tie-break: orthogonality); at an endpoint hit the distance is
 *      replaced by the distance to the extended tangent line when that is not
 *      larger (msdfgen `distanceToPseudoDistance`).
 *   3. OVERLAPPING CONTOUR combiner (msdfgen `OverlappingContourCombiner`).
 *      Variable fonts (Roboto Flex 't', 'R', …) draw stems and bars as
 *      separate overlapping contours; a naive nearest-edge field sees the
 *      hidden inner edges and tears the junction. Per-contour fields are
 *      combined by their windings so the union is rendered.
 *   4. Error correction: (a) the texel-centre median must agree in sign with
 *      the exact nonzero-winding signed distance, (b) the bilinear midpoint
 *      between neighbouring texels must too (this is where slivers thinner
 *      than a texel come from), (c) msdfgen's classic channel-clash test.
 *      Offending texels are flattened to the exact single-channel distance,
 *      which can only round a corner by < 1 texel, never tear it.
 *
 * JUSTIFICATION (state-and-justify, global 3D rule): per-pixel nearest-edge
 * distance over a handful of béziers is scalar math — no GPU, no wasm binary,
 * any font, worker-safe, Node-testable without a GPU. It reuses the FROZEN core
 * geometry (`commandsToContours`, `evalSegment`, `splitSegment`) and winding.
 */
import type { PathCommand, BBox } from '../../core/types.ts';
import type { Segment } from '../../core/geometry/segments.ts';
import { commandsToContours, evalSegment, splitSegment } from '../../core/geometry/segments.ts';
import { WindingIndex, windingNumber } from '../../core/winding.ts';
type Ring = [number, number][];

// Channel bit masks. Secondary colours each carry exactly two channels so that
// consecutive runs around a corner share exactly one channel.
const R = 1, G = 2, B = 4, WHITE = 7;
const YELLOW = R | G; // 3
const CYAN = G | B; // 6
const MAGENTA = R | B; // 5

export interface ColoredEdge {
  seg: Segment;
  /** channel bitmask (R=1, G=2, B=4). */
  mask: number;
  /** index of the contour this edge belongs to. */
  contour: number;
}

export interface MSDFOptions {
  /** Glyph bbox in font units (from analysis / opentype). */
  bbox: BBox;
  /** Pixels per em (raster size). Cell is sized from bbox·scale + padding. */
  fontSize: number;
  /** Font units per em (opentype getPath size). Default 1000. */
  unitsPerEm?: number;
  /** Distance range in TEXELS (msdfgen `-pxrange`). Default 8. */
  pxRange?: number;
  /** Padding texels around the glyph (≥ pxRange/2 so the field isn't clipped). Default = ceil(pxRange/2)+2. */
  padding?: number;
  /**
   * msdfgen angle threshold in RADIANS (`-angle`): a junction whose tangents
   * turn by more than this is a corner. Default 3 (msdfgen's default).
   */
  cornerThreshold?: number;
  /** @deprecated degrees form of `cornerThreshold`; converted if given. */
  cornerThresholdDeg?: number;
  /** Single-channel mode (exact distance in all channels) — rounds corners. */
  singleChannel?: boolean;
  /** Run the error-correction passes (default true). */
  errorCorrection?: boolean;
}

export interface MSDFBitmap {
  /** RGBA8, row-major, top-left origin. length = width*height*4 (A=255). */
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** Distance range in texels (goes to the shader as u_pxRange). */
  pxRange: number;
  /** Padding texels used (for UV rect derivation). */
  padding: number;
  /** Scale font-units → texels. */
  scale: number;
  /** Glyph bbox echoed back. */
  bbox: BBox;
  /** Glyph-space x of the LEFT edge of texel column 0 (= bbox.minX − padding/scale). */
  originX: number;
  /** Glyph-space y of the TOP edge of texel row 0 (= bbox.maxY + padding/scale). */
  originY: number;
  /** Number of texels flattened by error correction (diagnostics). */
  corrected: number;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function unit(x: number, y: number): [number, number] {
  const l = Math.hypot(x, y);
  return l > 1e-12 ? [x / l, y / l] : [0, 0];
}

function segBounds(seg: Segment): [number, number, number, number] {
  let x0 = seg.p0.x, y0 = seg.p0.y, x1 = seg.p0.x, y1 = seg.p0.y;
  const pts: { x: number; y: number }[] =
    seg.type === 'L' ? [seg.p1] : seg.type === 'Q' ? [seg.p1, seg.p2] : [seg.p1, seg.p2, seg.p3];
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return [x0, y0, x1, y1];
}

/** msdfgen switchColor: cycle CYAN→MAGENTA→YELLOW, honouring a banned colour. */
function switchColor(color: number, banned = 0): number {
  const combined = color & banned;
  if (combined === R || combined === G || combined === B) return combined ^ WHITE;
  if (color === 0 || color === WHITE) return CYAN;
  const shifted = color << 1;
  return (shifted | (shifted >> 3)) & WHITE;
}

/** msdfgen isCorner: reflex turn or |sin θ| above the threshold. */
function isCorner(a: Segment, b: Segment, crossThreshold: number): boolean {
  const ta = evalSegment(a, 1);
  const tb = evalSegment(b, 0);
  const [ax, ay] = unit(ta.tx, ta.ty);
  const [bx, by] = unit(tb.tx, tb.ty);
  const dot = ax * bx + ay * by;
  const cross = ax * by - ay * bx;
  return dot <= 0 || Math.abs(cross) > crossThreshold;
}

// ── edge coloring (msdfgen edgeColoringSimple) ───────────────────────────────

export interface ColorEdgesOptions {
  /** angle threshold in radians (default 3). */
  cornerThreshold?: number;
  singleChannel?: boolean;
}

/**
 * Colour a glyph's edges (msdfgen "simple" scheme). Smooth loops stay WHITE;
 * a contour with ONE corner is split into three colours (teardrop); otherwise
 * runs between corners cycle through the two-channel palette so adjacent runs
 * share exactly one channel and the last run never equals the first.
 */
export function colorEdges(commands: PathCommand[], opts: ColorEdgesOptions = {}): ColoredEdge[] {
  const contours = commandsToContours(commands);
  const crossThreshold = Math.sin(opts.cornerThreshold ?? 3);
  const out: ColoredEdge[] = [];

  contours.forEach((segs, contourIdx) => {
    const n = segs.length;
    if (n === 0) return;
    if (opts.singleChannel) {
      for (const seg of segs) out.push({ seg, mask: WHITE, contour: contourIdx });
      return;
    }

    const corners: number[] = [];
    for (let i = 0; i < n; i++) {
      const prev = segs[(i - 1 + n) % n];
      if (isCorner(prev, segs[i], crossThreshold)) corners.push(i);
    }

    if (corners.length === 0) {
      for (const seg of segs) out.push({ seg, mask: WHITE, contour: contourIdx });
      return;
    }

    if (corners.length === 1) {
      // Teardrop: three colours around the single corner.
      const c0 = switchColor(WHITE); // CYAN
      const c2 = switchColor(c0); // MAGENTA
      const colors = [c0, WHITE, c2];
      const corner = corners[0];
      if (n >= 3) {
        for (let i = 0; i < n; i++) {
          const idx = Math.floor(3 + (2.875 * i) / (n - 1) - 1.4375 + 0.5) - 3; // -1..1
          out.push({ seg: segs[(corner + i) % n], mask: colors[idx + 1], contour: contourIdx });
        }
      } else if (n === 2) {
        const a = splitSegment(segs[corner], 1 / 3);
        const a2 = splitSegment(a.right, 1 / 2);
        out.push({ seg: a.left, mask: colors[0], contour: contourIdx });
        out.push({ seg: a2.left, mask: colors[1], contour: contourIdx });
        out.push({ seg: a2.right, mask: colors[2], contour: contourIdx });
        const b = splitSegment(segs[(corner + 1) % n], 1 / 3);
        const b2 = splitSegment(b.right, 1 / 2);
        out.push({ seg: b.left, mask: colors[0], contour: contourIdx });
        out.push({ seg: b2.left, mask: colors[1], contour: contourIdx });
        out.push({ seg: b2.right, mask: colors[2], contour: contourIdx });
      } else {
        const a = splitSegment(segs[0], 1 / 3);
        const a2 = splitSegment(a.right, 1 / 2);
        out.push({ seg: a.left, mask: colors[0], contour: contourIdx });
        out.push({ seg: a2.left, mask: colors[1], contour: contourIdx });
        out.push({ seg: a2.right, mask: colors[2], contour: contourIdx });
      }
      return;
    }

    // Multiple corners: colour runs, banning the initial colour for the last run.
    const cornerCount = corners.length;
    let spline = 0;
    const start = corners[0];
    let color = switchColor(WHITE);
    const initialColor = color;
    for (let i = 0; i < n; i++) {
      const index = (start + i) % n;
      if (spline + 1 < cornerCount && corners[spline + 1] === index) {
        spline++;
        color = switchColor(color, spline === cornerCount - 1 ? initialColor : 0);
      }
      out.push({ seg: segs[index], mask: color, contour: contourIdx });
    }
  });
  return out;
}

// ── per-edge signed distance ─────────────────────────────────────────────────

/** Nearest parameter t∈[0,1] on a segment to point (px,py): coarse scan + ternary refine. */
function nearestT(seg: Segment, px: number, py: number): number {
  if (seg.type === 'L') {
    const dx = seg.p1.x - seg.p0.x;
    const dy = seg.p1.y - seg.p0.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-18) return 0;
    const t = ((px - seg.p0.x) * dx + (py - seg.p0.y) * dy) / len2;
    return t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const K = 10;
  let bestT = 0;
  let bestD = Infinity;
  for (let i = 0; i <= K; i++) {
    const t = i / K;
    const p = evalSegment(seg, t);
    const d = (p.x - px) ** 2 + (p.y - py) ** 2;
    if (d < bestD) { bestD = d; bestT = t; }
  }
  let lo = Math.max(0, bestT - 1 / K);
  let hi = Math.min(1, bestT + 1 / K);
  for (let it = 0; it < 14; it++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const p1 = evalSegment(seg, m1);
    const p2 = evalSegment(seg, m2);
    const d1 = (p1.x - px) ** 2 + (p1.y - py) ** 2;
    const d2 = (p2.x - px) ** 2 + (p2.y - py) ** 2;
    if (d1 < d2) hi = m2; else lo = m1;
  }
  return (lo + hi) / 2;
}

interface EdgeHit {
  /** |true distance| to the segment. */
  abs: number;
  /** signed value stored for the channel: true distance, or pseudo-distance at an endpoint hit. */
  value: number;
  /** |dot(dir, toPoint)| — 0 = perpendicular hit (best), →1 = grazing. */
  dot: number;
}

/**
 * msdfgen signedDistance + distanceToPseudoDistance. Sign: positive on the LEFT
 * of the edge direction (contour orientation is resolved by the caller).
 */
function edgeHit(seg: Segment, px: number, py: number): EdgeHit {
  const t = nearestT(seg, px, py);
  const e = evalSegment(seg, t);
  const dpx = px - e.x;
  const dpy = py - e.y;
  const abs = Math.hypot(dpx, dpy);
  const [ux, uy] = unit(e.tx, e.ty);
  const cross = ux * dpy - uy * dpx;
  const sign = cross >= 0 ? 1 : -1;
  let value = sign * abs;
  let dot = abs > 1e-12 ? Math.abs((ux * dpx + uy * dpy) / abs) : 0;
  if (t <= 0 || t >= 1) {
    // Endpoint hit: projection beyond the segment → pseudo-distance to the
    // extended tangent line, if not larger in magnitude (msdfgen).
    const ts = ux * dpx + uy * dpy;
    if ((t <= 0 && ts < 0) || (t >= 1 && ts > 0)) {
      if (Math.abs(cross) <= abs) {
        value = cross;
        dot = 0;
      }
    }
  }
  return { abs, value, dot };
}

interface Edge extends ColoredEdge {
  bx0: number; by0: number; bx1: number; by1: number;
}

interface Field {
  r: number; g: number; b: number;
  /** exact signed distance (nonzero winding sign × nearest-edge distance). */
  sd: number;
}

class ShapeEvaluator {
  private readonly edges: Edge[];
  private readonly contourCount: number;
  /** +1 for outer (shape) contours, −1 for holes, msdfgen `windings[]`. */
  private readonly windings: number[];
  private readonly orient: number;
  private readonly rings: Ring[];
  private readonly index: WindingIndex;
  private readonly far: number;
  // scratch per contour × channel
  private readonly bestAbs: Float64Array;
  private readonly bestDot: Float64Array;
  private readonly bestVal: Float64Array;

  constructor(commands: PathCommand[], colored: ColoredEdge[], far: number) {
    this.far = far;
    this.edges = colored.map((ce) => {
      const [bx0, by0, bx1, by1] = segBounds(ce.seg);
      return { ...ce, bx0, by0, bx1, by1 };
    });
    const contours = commandsToContours(commands);
    this.contourCount = contours.length;
    // Flatten contours finely for an exact nonzero-winding inside test.
    this.rings = contours.map((segs) => {
      const ring: Ring = [];
      for (const s of segs) {
        const n = s.type === 'L' ? 1 : 12;
        for (let k = 0; k < n; k++) {
          const p = evalSegment(s, k / n);
          ring.push([p.x, p.y]);
        }
      }
      return ring;
    });
    this.index = new WindingIndex(this.rings);
    // Contour orientation via shoelace; the largest contour defines "outer".
    const areas = this.rings.map((ring) => {
      let a = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      }
      return a / 2;
    });
    let big = 0;
    for (let i = 1; i < areas.length; i++) if (Math.abs(areas[i]) > Math.abs(areas[big])) big = i;
    const outerSign = areas.length && areas[big] < 0 ? -1 : 1;
    // Left-of-direction is positive inside a CCW (positive-area) contour, so
    // `orient` makes the outer contour's interior positive.
    this.orient = outerSign;
    this.windings = areas.map((a) => (a === 0 ? 1 : Math.sign(a) * outerSign));
    this.bestAbs = new Float64Array(this.contourCount * 3);
    this.bestDot = new Float64Array(this.contourCount * 3);
    this.bestVal = new Float64Array(this.contourCount * 3);
  }

  inside(px: number, py: number): boolean {
    return this.index.inside(px, py);
  }

  /** Exact signed distance (winding sign, nearest true distance), no colouring. */
  signedDistance(px: number, py: number): number {
    let m = Infinity;
    for (const e of this.edges) {
      const lb = boundsDistance(e, px, py);
      if (lb >= m) continue;
      const t = nearestT(e.seg, px, py);
      const p = evalSegment(e.seg, t);
      const d = Math.hypot(p.x - px, p.y - py);
      if (d < m) m = d;
    }
    if (!Number.isFinite(m)) m = this.far;
    return this.inside(px, py) ? m : -m;
  }

  evaluate(px: number, py: number): Field {
    const C = this.contourCount;
    const bestAbs = this.bestAbs, bestDot = this.bestDot, bestVal = this.bestVal;
    bestAbs.fill(Infinity);
    let trueMin = Infinity;
    for (const e of this.edges) {
      const lb = boundsDistance(e, px, py);
      if (lb > this.far && lb >= trueMin) continue;
      const h = edgeHit(e.seg, px, py);
      if (h.abs < trueMin) trueMin = h.abs;
      const base = e.contour * 3;
      for (let ch = 0; ch < 3; ch++) {
        if ((e.mask & (1 << ch)) === 0) continue;
        const k = base + ch;
        if (h.abs < bestAbs[k] || (h.abs === bestAbs[k] && h.dot < bestDot[k])) {
          bestAbs[k] = h.abs;
          bestDot[k] = h.dot;
          bestVal[k] = this.orient * h.value;
        }
      }
    }
    const insideShape = this.inside(px, py);
    const sd = insideShape ? (Number.isFinite(trueMin) ? trueMin : this.far) : -(Number.isFinite(trueMin) ? trueMin : this.far);

    // Per-contour fill-in for channels with no edge in range: far, signed by
    // that contour's own interior.
    for (let c = 0; c < C; c++) {
      let missing = false;
      for (let ch = 0; ch < 3; ch++) if (!Number.isFinite(bestAbs[c * 3 + ch])) { missing = true; break; }
      if (!missing) continue;
      const inC = windingNumber(px, py, [this.rings[c]]) !== 0;
      const v = (inC ? 1 : -1) * this.windings[c] * this.far * 2;
      for (let ch = 0; ch < 3; ch++) {
        const k = c * 3 + ch;
        if (!Number.isFinite(bestAbs[k])) { bestAbs[k] = this.far * 2; bestDot[k] = 1; bestVal[k] = v; }
      }
    }

    if (C === 1) return { r: bestVal[0], g: bestVal[1], b: bestVal[2], sd };
    return this.combine(sd);
  }

  /** msdfgen OverlappingContourCombiner::distance(). */
  private combine(sd: number): Field {
    const C = this.contourCount;
    const bestAbs = this.bestAbs, bestDot = this.bestDot, bestVal = this.bestVal;
    const shape = [0, 0, 0], inner = [0, 0, 0], outer = [0, 0, 0];
    const shapeA = [Infinity, Infinity, Infinity], innerA = [Infinity, Infinity, Infinity], outerA = [Infinity, Infinity, Infinity];
    const shapeD = [1, 1, 1], innerD = [1, 1, 1], outerD = [1, 1, 1];
    const merge = (dst: number[], dstA: number[], dstD: number[], c: number): void => {
      for (let ch = 0; ch < 3; ch++) {
        const k = c * 3 + ch;
        if (bestAbs[k] < dstA[ch] || (bestAbs[k] === dstA[ch] && bestDot[k] < dstD[ch])) {
          dstA[ch] = bestAbs[k]; dstD[ch] = bestDot[k]; dst[ch] = bestVal[k];
        }
      }
    };
    const medC = (c: number): number => median3(bestVal[c * 3], bestVal[c * 3 + 1], bestVal[c * 3 + 2]);
    let innerAny = false, outerAny = false;
    for (let c = 0; c < C; c++) {
      merge(shape, shapeA, shapeD, c);
      const m = medC(c);
      if (this.windings[c] > 0 && m >= 0) { merge(inner, innerA, innerD, c); innerAny = true; }
      if (this.windings[c] < 0 && m <= 0) { merge(outer, outerA, outerD, c); outerAny = true; }
    }
    const innerS = innerAny ? median3(inner[0], inner[1], inner[2]) : -Infinity;
    const outerS = outerAny ? median3(outer[0], outer[1], outer[2]) : Infinity;
    let dist: number[];
    let winding = 0;
    if (innerS >= 0 && Math.abs(innerS) <= Math.abs(outerS)) {
      dist = inner.slice();
      winding = 1;
      for (let c = 0; c < C; c++) {
        if (this.windings[c] > 0) {
          const m = medC(c);
          if (Math.abs(m) < Math.abs(outerS) && m > median3(dist[0], dist[1], dist[2])) {
            dist = [bestVal[c * 3], bestVal[c * 3 + 1], bestVal[c * 3 + 2]];
          }
        }
      }
    } else if (outerS <= 0 && Math.abs(outerS) < Math.abs(innerS)) {
      dist = outer.slice();
      winding = -1;
      for (let c = 0; c < C; c++) {
        if (this.windings[c] < 0) {
          const m = medC(c);
          if (Math.abs(m) < Math.abs(innerS) && m < median3(dist[0], dist[1], dist[2])) {
            dist = [bestVal[c * 3], bestVal[c * 3 + 1], bestVal[c * 3 + 2]];
          }
        }
      }
    } else {
      return { r: shape[0], g: shape[1], b: shape[2], sd };
    }
    for (let c = 0; c < C; c++) {
      if (this.windings[c] !== winding) {
        const m = medC(c);
        const dm = median3(dist[0], dist[1], dist[2]);
        if (m * dm >= 0 && Math.abs(m) < Math.abs(dm)) {
          dist = [bestVal[c * 3], bestVal[c * 3 + 1], bestVal[c * 3 + 2]];
        }
      }
    }
    const shapeM = median3(shape[0], shape[1], shape[2]);
    if (median3(dist[0], dist[1], dist[2]) === shapeM) dist = shape;
    return { r: dist[0], g: dist[1], b: dist[2], sd };
  }
}

function boundsDistance(e: Edge, px: number, py: number): number {
  const dx = px < e.bx0 ? e.bx0 - px : px > e.bx1 ? px - e.bx1 : 0;
  const dy = py < e.by0 ? e.by0 - py : py > e.by1 ? py - e.by1 : 0;
  return Math.hypot(dx, dy);
}

// ── bitmap generation ────────────────────────────────────────────────────────

export function generateMSDF(commands: PathCommand[], options: MSDFOptions): MSDFBitmap {
  const upm = options.unitsPerEm ?? 1000;
  const pxRange = options.pxRange ?? 8;
  const scale = options.fontSize / upm;
  const pad = options.padding ?? Math.ceil(pxRange / 2) + 2;
  const { bbox } = options;
  const single = options.singleChannel ?? false;
  const cornerThreshold =
    options.cornerThreshold ??
    (options.cornerThresholdDeg !== undefined ? (options.cornerThresholdDeg * Math.PI) / 180 : 3);

  const glyphW = Math.max(1e-3, bbox.maxX - bbox.minX);
  const glyphH = Math.max(1e-3, bbox.maxY - bbox.minY);
  const width = Math.max(1, Math.ceil(glyphW * scale) + 2 * pad);
  const height = Math.max(1, Math.ceil(glyphH * scale) + 2 * pad);

  const rangeGlyph = pxRange / scale; // distance range in font units
  const texel = 1 / scale;
  const colored = colorEdges(commands, { cornerThreshold, singleChannel: single });
  const shape = new ShapeEvaluator(commands, colored, rangeGlyph * 1.5 + texel);

  const originX = bbox.minX - pad / scale;
  const originY = bbox.maxY + pad / scale;
  // texel (i,j) centre → glyph coords. Image is y-down; glyph y is up.
  const toGlyphX = (i: number): number => originX + (i + 0.5) / scale;
  const toGlyphY = (j: number): number => originY - (j + 0.5) / scale;

  const field = new Float32Array(width * height * 3);
  const exact = new Float32Array(width * height);

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const gx = toGlyphX(i);
      const gy = toGlyphY(j);
      const o = j * width + i;
      if (single) {
        const sd = shape.signedDistance(gx, gy);
        field[o * 3] = field[o * 3 + 1] = field[o * 3 + 2] = sd;
        exact[o] = sd;
      } else {
        const f = shape.evaluate(gx, gy);
        field[o * 3] = f.r;
        field[o * 3 + 1] = f.g;
        field[o * 3 + 2] = f.b;
        exact[o] = f.sd;
      }
    }
  }

  let corrected = 0;
  if (!single && (options.errorCorrection ?? true)) {
    corrected = errorCorrect(field, exact, width, height, texel, shape, toGlyphX, toGlyphY);
  }

  const data = new Uint8ClampedArray(width * height * 4);
  for (let o = 0; o < width * height; o++) {
    data[o * 4] = encode(field[o * 3], rangeGlyph);
    data[o * 4 + 1] = encode(field[o * 3 + 1], rangeGlyph);
    data[o * 4 + 2] = encode(field[o * 3 + 2], rangeGlyph);
    data[o * 4 + 3] = 255;
  }

  return { data, width, height, pxRange, padding: pad, scale, bbox, originX, originY, corrected };
}

/**
 * Error correction. Flattens a texel to its exact signed distance when
 *   (a) its median disagrees in sign with the exact distance,
 *   (b) the bilinear midpoint towards a right/bottom neighbour reconstructs the
 *       wrong sign (sub-texel slivers), or
 *   (c) msdfgen's classic clash test fires against any 4-neighbour.
 */
function errorCorrect(
  field: Float32Array,
  exact: Float32Array,
  width: number,
  height: number,
  texel: number,
  shape: ShapeEvaluator,
  toGlyphX: (i: number) => number,
  toGlyphY: (j: number) => number,
): number {
  let count = 0;
  const flat = new Uint8Array(width * height);
  const flatten = (o: number): void => {
    if (flat[o]) return;
    flat[o] = 1;
    count++;
    field[o * 3] = field[o * 3 + 1] = field[o * 3 + 2] = exact[o];
  };
  const med = (o: number): number => median3(field[o * 3], field[o * 3 + 1], field[o * 3 + 2]);

  // (a) texel-centre sign agreement.
  for (let o = 0; o < width * height; o++) {
    const m = med(o);
    const sd = exact[o];
    if (Math.abs(sd) > 0.02 * texel && (m > 0) !== (sd > 0)) flatten(o);
  }

  // (b) midpoints between horizontal / vertical neighbours.
  const eps = 0.05 * texel;
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const o = j * width + i;
      if (i + 1 < width) {
        const p = o + 1;
        const mid = median3(
          (field[o * 3] + field[p * 3]) / 2,
          (field[o * 3 + 1] + field[p * 3 + 1]) / 2,
          (field[o * 3 + 2] + field[p * 3 + 2]) / 2,
        );
        // Only evaluate the exact distance where a mistake is plausible: both
        // centres are within a texel of an edge or their medians differ in sign.
        if (Math.abs(exact[o]) < 1.5 * texel || Math.abs(exact[p]) < 1.5 * texel) {
          const sd = shape.signedDistance(toGlyphX(i) + texel / 2, toGlyphY(j));
          if (Math.abs(sd) > eps && (mid > 0) !== (sd > 0)) {
            flatten(Math.abs(med(o)) >= Math.abs(med(p)) ? o : p);
          }
        }
      }
      if (j + 1 < height) {
        const p = o + width;
        const mid = median3(
          (field[o * 3] + field[p * 3]) / 2,
          (field[o * 3 + 1] + field[p * 3 + 1]) / 2,
          (field[o * 3 + 2] + field[p * 3 + 2]) / 2,
        );
        if (Math.abs(exact[o]) < 1.5 * texel || Math.abs(exact[p]) < 1.5 * texel) {
          const sd = shape.signedDistance(toGlyphX(i), toGlyphY(j) - texel / 2);
          if (Math.abs(sd) > eps && (mid > 0) !== (sd > 0)) {
            flatten(Math.abs(med(o)) >= Math.abs(med(p)) ? o : p);
          }
        }
      }
    }
  }

  // (c) msdfgen classic clash detection (threshold 1.001 texels).
  const threshold = 1.001 * texel;
  const clashes: number[] = [];
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const o = j * width + i;
      if (
        (i > 0 && detectClash(field, o, o - 1, threshold)) ||
        (i < width - 1 && detectClash(field, o, o + 1, threshold)) ||
        (j > 0 && detectClash(field, o, o - width, threshold)) ||
        (j < height - 1 && detectClash(field, o, o + width, threshold))
      ) {
        clashes.push(o);
      }
    }
  }
  for (const o of clashes) flatten(o);
  return count;
}

function detectClash(field: Float32Array, oa: number, ob: number, threshold: number): boolean {
  let a0 = field[oa * 3], a1 = field[oa * 3 + 1], a2 = field[oa * 3 + 2];
  let b0 = field[ob * 3], b1 = field[ob * 3 + 1], b2 = field[ob * 3 + 2];
  let t: number;
  if (Math.abs(b0 - a0) < Math.abs(b1 - a1)) { t = a0; a0 = a1; a1 = t; t = b0; b0 = b1; b1 = t; }
  if (Math.abs(b1 - a1) < Math.abs(b2 - a2)) {
    t = a1; a1 = a2; a2 = t; t = b1; b1 = b2; b2 = t;
    if (Math.abs(b0 - a0) < Math.abs(b1 - a1)) { t = a0; a0 = a1; a1 = t; t = b0; b0 = b1; b1 = t; }
  }
  return (
    Math.abs(b1 - a1) >= threshold &&
    !(b0 === b1 && b0 === b2) && // other texel already equalised
    Math.abs(a2) >= Math.abs(b2) // flag the texel farther from the edge
  );
}

/** msdfgen median of three channels (matches the fragment shader). */
export function median3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/** signed distance (font units) → [0,255], 0.5·255 at the edge (msdfgen encoding). */
function encode(signed: number, rangeGlyph: number): number {
  const v = 0.5 + signed / rangeGlyph;
  return Math.round(Math.max(0, Math.min(1, v)) * 255);
}
