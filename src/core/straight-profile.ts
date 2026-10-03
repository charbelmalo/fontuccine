/**
 * straight-profile.ts — which columns of a glyph may widen WITHOUT distorting it.
 *
 * The stretch model is a column-wise (x-only) remap: a slice that widens by g
 * scales every stroke crossing it horizontally by g. That is harmless for a
 * horizontal span (a bar or the flat top of an arc just gets longer) and
 * destructive for anything steep: a stroke at angle θ from horizontal keeps
 * its vertical extent while its horizontal extent grows, so its perpendicular
 * thickness becomes
 *
 *     t' / t = g / sqrt(g²·cos²θ + sin²θ)
 *
 * (+97 % for Roboto Flex's 70° diagonals at g = 2.5), and when neighbouring
 * slices widen by different amounts a straight diagonal is bent into a
 * dog-leg. That is exactly what happened to 'y' (left arm kinked, right arm
 * doubled in weight) under the nearest-boundary flex profile alone, which
 * gives 45° strokes ~6 % flex at k = 8 and lets smoothing / the share cap leak
 * width into diagonal columns.
 *
 * The STRAIGHT profile is therefore a stricter, two-part test per slice:
 *
 *   1. stroke direction (Pagurek, unsmoothed): min over interior samples of
 *      |τ̂ · x̂|^k with τ̂ the nearest boundary tangent — rejects vertical stems,
 *      whose column ink is bounded by flat terminals.
 *   2. crossing mask: every VISIBLE outline crossing of the column (sampled at
 *      several sub-columns) must be near-horizontal — full weight up to
 *      `flatAngle`, zero from `maxAngle`, smooth in between. Any diagonal edge
 *      in the column (a 'v' arm, the notch of an apex, a 'k' leg) zeroes it.
 *
 * weight = min(smooth(flex · mask), mask)  ∈ [0, 1]; empty columns are 1.
 * A diagonal-only glyph (v w x y k A …) gets an all-zero profile: it never
 * widens by slicing, only by real variable-font instances (width-plan.ts).
 */
import type { SampledOutline, Bounds1D } from './types.ts';
import { computeFlexProfile } from './flex-profile.ts';
import type { FlexField } from './flex-profile.ts';

export interface StraightProfileOptions {
  slices: number;
  /** Ink bounds along x. */
  bounds: Bounds1D;
  /** Ink bounds along y (interior sampling range). */
  crossBounds: Bounds1D;
  /** Stroke-direction exponent (edgeProtection). Default 8. */
  k?: number;
  interiorSamples?: number;
  /** Gaussian sigma in slices applied to flex·mask. Default 0.75. */
  smooth?: number;
  /** Crossings at or below this angle from horizontal count fully (deg). Default 10. */
  flatAngle?: number;
  /** Crossings at or above this angle zero the slice (deg). Default 24. */
  maxAngle?: number;
  /** Sub-columns tested per slice. Default 4. */
  subColumns?: number;
  field?: FlexField;
}

type Ring = Array<[number, number]>;

/** Weight of one crossing from its edge direction (|cos| of the angle to x̂). */
function crossingWeight(absCos: number, cosFlat: number, cosMax: number): number {
  if (absCos >= cosFlat) return 1;
  if (absCos <= cosMax) return 0;
  const t = (absCos - cosMax) / (cosFlat - cosMax);
  return t * t * (3 - 2 * t); // smoothstep
}

/**
 * Per-slice crossing mask (see header). Only VISIBLE crossings count: with
 * overlapping contours (Roboto Flex draws 't', 'R', 'B' that way) an edge
 * buried inside other ink does not bound anything and is ignored.
 */
export function crossingMask(
  rings: Ring[],
  bounds: Bounds1D,
  slices: number,
  opts: { flatAngle?: number; maxAngle?: number; subColumns?: number } = {},
): Float32Array {
  const flat = ((opts.flatAngle ?? 10) * Math.PI) / 180;
  const maxA = ((opts.maxAngle ?? 24) * Math.PI) / 180;
  const cosFlat = Math.cos(flat);
  const cosMax = Math.cos(maxA);
  const sub = Math.max(1, opts.subColumns ?? 4);
  const span = bounds.max - bounds.min;
  const out = new Float32Array(slices).fill(1);
  if (!(span > 0)) return out;

  const ys: number[] = [];
  const dirs: number[] = [];
  const ws: number[] = [];
  const order: number[] = [];
  for (let i = 0; i < slices; i++) {
    let m = 1;
    for (let j = 0; j < sub && m > 0; j++) {
      const a = bounds.min + ((i + (j + 0.5) / sub) / slices) * span;
      ys.length = dirs.length = ws.length = order.length = 0;
      for (const ring of rings) {
        const n = ring.length;
        if (n < 3) continue;
        for (let p = 0, q = n - 1; p < n; q = p++) {
          const [x0, y0] = ring[q];
          const [x1, y1] = ring[p];
          if ((x0 <= a && a < x1) || (x1 <= a && a < x0)) {
            const t = (a - x0) / (x1 - x0);
            const dx = x1 - x0;
            const dy = y1 - y0;
            const len = Math.hypot(dx, dy) || 1;
            ys.push(y0 + t * dy);
            dirs.push(x1 > x0 ? 1 : -1);
            ws.push(crossingWeight(Math.abs(dx) / len, cosFlat, cosMax));
            order.push(order.length);
          }
        }
      }
      if (order.length === 0) continue;
      order.sort((u, v) => ys[u] - ys[v]);
      // Walk the column; a crossing is visible iff insideness flips across it.
      let wind = 0;
      for (const idx of order) {
        const before = wind !== 0;
        wind += dirs[idx];
        const after = wind !== 0;
        if (before !== after && ws[idx] < m) m = ws[idx];
      }
    }
    out[i] = m;
  }
  return out;
}

export function computeStraightProfile(outline: SampledOutline, options: StraightProfileOptions): Float32Array {
  const { slices, bounds, crossBounds, k = 8, interiorSamples = 48, smooth = 0.75 } = options;
  const N = slices;
  if (!(bounds.max - bounds.min > 0) || outline.samples.length === 0) return new Float32Array(N).fill(1);
  const raw = computeFlexProfile(outline, {
    axis: 'x',
    slices: N,
    k,
    bounds,
    crossBounds,
    interiorSamples,
    smooth: 0,
    maxShareFactor: Infinity,
    edgeClamp: true,
    ...(options.field ? { field: options.field } : {}),
  });
  const mask = crossingMask(outline.polygons, bounds, N, options);
  const prod = new Float32Array(N);
  for (let i = 0; i < N; i++) prod[i] = raw[i] * mask[i];
  const sm = smooth > 0 ? gaussian(prod, smooth) : prod;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const v = Math.min(sm[i], mask[i]);
    out[i] = v < 1e-3 ? 0 : v; // a sliver of weight on a diagonal is still a kink
  }
  return out;
}

function gaussian(arr: Float32Array, sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel: number[] = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(w);
    sum += w;
  }
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let acc = 0;
    for (let j = -radius; j <= radius; j++) {
      const idx = Math.min(arr.length - 1, Math.max(0, i + j));
      acc += arr[idx] * kernel[j + radius];
    }
    out[i] = acc / sum;
  }
  return out;
}
