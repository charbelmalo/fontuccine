/**
 * flex-profile.ts — the tangent-aligned flex profile (Pagurek 2025),
 * productionized for < 5ms/glyph/axis at 96 slices.
 *
 *   flex(slice) = 1                                if slice ∩ glyph = ∅
 *               = min over interior p of |τ̂(p) · ŝ|^k   otherwise
 *
 * Each INTERIOR point takes the tangent of its NEAREST boundary sample — that
 * is what encodes local stroke direction. The boundary-bucketing shortcut is
 * FALSIFIED (RESEARCH §1.1). Keep the nearest-boundary field.
 *
 * Performance architecture:
 *  - Sampling, winding-filter and the k-d tree are built ONCE per glyph in a
 *    FlexField (buildFlexField), then shared by both axes. Analysis is static.
 *  - Point-in-glyph is a per-slice SCANLINE (one edge sweep per slice) instead
 *    of a winding test per interior point — O(E) per slice, not O(E) per point.
 *  - Nearest lookup is the k-d tree (spatial/kdtree.ts); a brute mode is kept
 *    for the T2 parity test. Both share the same scanline, so results match.
 */
import type { SampledOutline, Bounds1D, Axis, BoundarySample } from './types.ts';
import { filterVisibleSamples } from './winding.ts';
import { KDTree } from './spatial/kdtree.ts';

type Ring = Array<[number, number]>;

/** Prebuilt, axis-independent analysis state for one glyph. */
export interface FlexField {
  polygons: Ring[];
  samples: BoundarySample[];
  /** Nearest boundary sample index for a query point. */
  nearest: (x: number, y: number) => number;
}

export interface FieldOptions {
  spatial?: 'kdtree' | 'brute';
  filterInvisible?: boolean;
}

/** Build the shared per-glyph field (sampling → winding-filter → k-d tree). */
export function buildFlexField(outline: SampledOutline, options: FieldOptions = {}): FlexField {
  const { spatial = 'kdtree', filterInvisible = true } = options;
  const raw = outline.samples;
  const samples = filterInvisible ? filterVisibleSamples(raw, outline.polygons) : raw;

  let nearest: (x: number, y: number) => number;
  if (samples.length === 0) {
    nearest = () => -1;
  } else if (spatial === 'brute') {
    nearest = (x, y) => {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const d = (s.x - x) * (s.x - x) + (s.y - y) * (s.y - y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    };
  } else {
    const tree = new KDTree(samples);
    nearest = (x, y) => tree.nearest(x, y);
  }

  return { polygons: outline.polygons, samples, nearest };
}

export interface FlexProfileOptions {
  axis: Axis;
  slices?: number;
  k?: number;
  bounds: Bounds1D;
  crossBounds: Bounds1D;
  interiorSamples?: number;
  smooth?: number;
  /** 'kdtree' (default) or 'brute' — brute is for parity testing only. */
  spatial?: 'kdtree' | 'brute';
  /** Winding-filter invisible self-intersection samples (default true). */
  filterInvisible?: boolean;
  /** Edge-clamp first/last slice to their neighbour (default true). */
  edgeClamp?: boolean;
  /** Reuse a prebuilt field (both axes of a glyph share one). */
  field?: FlexField;
  /**
   * Per-slice share cap, applied LAST (see capFlexShares): no slice may take
   * more than `maxShareFactor`× its uniform share (1/N) of the extra width.
   * Default 4. `Infinity` disables it and returns the raw profile.
   */
  maxShareFactor?: number;
}

/** Default per-slice share cap (see capFlexShares / DEFAULT_PARAMS). */
export const DEFAULT_MAX_SHARE_FACTOR = 4;

/**
 * Nonzero-winding crossings of the outline with the line {stretch-axis = a}.
 * Reused for every interior sample in the slice. Returns parallel arrays of
 * cross-axis crossing coordinates and their winding direction (±1), so
 * inside(c) = (Σ dir where crossing > c) ≠ 0.
 */
function sliceCrossings(
  rings: Ring[],
  a: number,
  axis: Axis,
  outCross: number[],
  outDir: number[],
): number {
  let n = 0;
  for (const ring of rings) {
    const m = ring.length;
    if (m < 3) continue;
    for (let i = 0, j = m - 1; i < m; j = i++) {
      const pi = ring[i];
      const pj = ring[j];
      // a-coord = stretch axis; c-coord = cross axis
      const a0 = axis === 'x' ? pj[0] : pj[1];
      const a1 = axis === 'x' ? pi[0] : pi[1];
      if ((a0 <= a && a < a1) || (a1 <= a && a < a0)) {
        const c0 = axis === 'x' ? pj[1] : pj[0];
        const c1 = axis === 'x' ? pi[1] : pi[0];
        const t = (a - a0) / (a1 - a0);
        outCross[n] = c0 + t * (c1 - c0);
        outDir[n] = a1 > a0 ? 1 : -1;
        n++;
      }
    }
  }
  return n;
}

export function computeFlexProfile(
  outline: SampledOutline,
  options: FlexProfileOptions,
): Float32Array {
  const {
    axis,
    slices = 64,
    k = 8,
    bounds,
    crossBounds,
    interiorSamples = 48,
    smooth = 0.75,
    spatial = 'kdtree',
    filterInvisible = true,
    edgeClamp = true,
    maxShareFactor = DEFAULT_MAX_SHARE_FACTOR,
  } = options;

  const { min, max } = bounds;
  const span = max - min;
  if (span <= 0 || outline.samples.length === 0) return new Float32Array(slices).fill(1);

  const field = options.field ?? buildFlexField(outline, { spatial, filterInvisible });
  const { polygons, samples, nearest } = field;
  if (samples.length === 0) return new Float32Array(slices).fill(1);

  const cMin = crossBounds.min;
  const cSpan = crossBounds.max - crossBounds.min;
  const flex = new Float32Array(slices).fill(1); // empty slice → fully stretchy

  // Reused scratch for crossings (grows as needed).
  const cross: number[] = [];
  const dir: number[] = [];

  for (let i = 0; i < slices; i++) {
    const a = min + ((i + 0.5) / slices) * span; // slice center on stretch axis
    const nc = sliceCrossings(polygons, a, axis, cross, dir);
    if (nc === 0) continue; // slice misses the glyph → stays 1

    let m = Infinity;
    for (let j = 0; j < interiorSamples; j++) {
      const c = cMin + ((j + 0.5) / interiorSamples) * cSpan;
      // nonzero-winding inside test via the precomputed crossings
      let wind = 0;
      for (let e = 0; e < nc; e++) if (cross[e] > c) wind += dir[e];
      if (wind === 0) continue;

      const x = axis === 'x' ? a : c;
      const y = axis === 'x' ? c : a;
      const ni = nearest(x, y);
      if (ni < 0) continue;
      const nb = samples[ni];
      const align = Math.abs(axis === 'x' ? nb.tx : nb.ty); // |τ̂ · ŝ|
      const f = Math.pow(align, k);
      if (f < m) m = f;
      if (m === 0) break;
    }
    if (Number.isFinite(m)) flex[i] = m;
  }

  if (edgeClamp && slices >= 2) {
    flex[0] = flex[1];
    flex[slices - 1] = flex[slices - 2];
  }

  const smoothed = smooth > 0 ? gaussianSmooth(flex, smooth) : flex;
  return capFlexShares(smoothed, maxShareFactor);
}

/**
 * Stretch-independent per-slice SHARE CAP with water-filling.
 *
 * Consumers (buildRemap, buildFlexCumulative) give slice i the share
 * s_i = flex_i / Σflex of the extra width. On diagonal-only glyphs ("w", "v",
 * "x", "A") nearly every slice is rigid and only the 1–3 apex slices, where the
 * tangent turns horizontal, have flex ≈ 1 — so proportional distribution dumps
 * the ENTIRE extra width into them (a single slice grows 30–50× at stretch 2.5
 * and the glyph reads as "v + flat slab + v"). Capping the share bounds any
 * slice's growth at  1 + (stretch − 1)·maxShareFactor  at every stretch.
 *
 * Algorithm: cap = maxShareFactor / N (a factor < 1 is treated as 1, since
 * cap·N < 1 is infeasible). Every share above the cap is clamped to it and the
 * removed excess is re-distributed over the uncapped slices proportionally to
 * (s_i + floor), floor = 0.5/N. The floor dominates the tiny raw shares of
 * rigid slices (|cos θ|^8 differs ~10× between a 70° and a 75° stroke), so the
 * overflow spreads ~evenly over the rigid slices instead of letting those tiny
 * differences decide how much each diagonal grows, while slices with meaningful
 * flex still take proportionally more. Repeated until no slice exceeds the cap; each pass that
 * does not converge caps ≥ 1 more slice, so ≤ N+1 passes.
 *
 * Output units: the capped shares are rescaled by the input's Σflex, i.e.
 * out_i = s'_i · Σflex. Σ is preserved, values stay in [0, 1] (every value is
 * ≤ cap·Σflex, which is below the flex of any slice that was capped, ≤ 1), and
 * buildRemap / buildFlexCumulative — which normalise by Σ — see exactly s'_i.
 * A profile that already respects the cap (or is fully rigid, Σ < 1e-9, which
 * consumers degrade to uniform scaling) is returned as an unchanged copy.
 * `maxShareFactor = Infinity` (or NaN / ≤ 0) disables the cap.
 */
export function capFlexShares(flex: Float32Array, maxShareFactor: number): Float32Array {
  const N = flex.length;
  const out = new Float32Array(flex);
  if (N === 0 || !(maxShareFactor > 0) || !Number.isFinite(maxShareFactor)) return out;

  let sum = 0;
  for (let i = 0; i < N; i++) sum += flex[i];
  if (!(sum >= 1e-9)) return out; // fully rigid → consumers use uniform scaling

  const cap = Math.max(1, maxShareFactor) / N;
  const s = new Float64Array(N);
  let over = false;
  for (let i = 0; i < N; i++) {
    s[i] = flex[i] / sum;
    if (s[i] > cap) over = true;
  }
  if (!over) return out;

  const floor = 0.5 / N;
  const capped = new Uint8Array(N);
  for (let pass = 0; pass <= N; pass++) {
    let excess = 0;
    for (let i = 0; i < N; i++) {
      if (!capped[i] && s[i] > cap) {
        excess += s[i] - cap;
        s[i] = cap;
        capped[i] = 1;
      }
    }
    if (excess < 1e-12) break;
    let weight = 0;
    for (let i = 0; i < N; i++) if (!capped[i]) weight += s[i] + floor;
    if (weight <= 0) break; // every slice at cap ⇒ Σ s = cap·N ≥ 1 already
    const k = excess / weight;
    for (let i = 0; i < N; i++) if (!capped[i]) s[i] += k * (s[i] + floor);
  }

  for (let i = 0; i < N; i++) out[i] = s[i] * sum;
  return out;
}

function gaussianSmooth(arr: Float32Array, sigma: number): Float32Array {
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
