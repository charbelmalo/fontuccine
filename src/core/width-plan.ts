/**
 * width-plan.ts — how a run gets wider without distorting a single glyph.
 *
 * A stretch ratio s asks for a run s× its resting width. The plan meets that
 * width in two stages, shared verbatim by the SVG and WebGL tiers:
 *
 *  1. REAL INSTANCES. `steps` are variable-font instances of the whole run
 *     (wdth, then XTRA — see engine/width-ladder.ts), sorted by run width. While
 *     the target width lies inside [steps[0].width, steps[last].width] the run
 *     is the linear blend of the two neighbouring instances. gvar outlines are
 *     piecewise linear in the axis coordinate, so with steps at the breakpoints
 *     the blend IS the type designer's instance: diagonals keep their designed
 *     weight and just lean further, counters open, stems stay put. No slicing.
 *
 *  2. RESIDUAL, beyond the widest (or narrowest) instance. The leftover width
 *     goes ONLY to places that can take it without distortion:
 *       - each glyph's straight columns (straight-profile.ts — horizontal
 *         spans; never stems, never diagonals), and
 *       - when widening, even tracking: every gap BETWEEN two glyphs carries a
 *         virtual measure of `plan.tracking` font units, and word spaces carry
 *         their own advance — the same extra space at every gap, like CSS
 *         letter-spacing, whatever the side bearings happen to be.
 *     All of that stretchy measure M grows by one common factor (1 + growth),
 *     so no single column carries the run. A glyph with no straight column
 *     ('v' 'w' 'x' 'y' 'k' 'A') keeps its widest designed shape and the extra
 *     width lands in the gaps around it. If nothing in the run can stretch (a
 *     lone 'y') the run SATURATES at its widest instance rather than
 *     distorting. Compression past the narrowest instance uses straight
 *     columns only (negative tracking would collide glyphs).
 *
 * Every per-frame quantity is linear in `growth` for a fixed step, which is
 * what lets the WebGL tier keep all geometry static and drive it by uniforms.
 */
import type { PathCommand, Bounds1D, BBox, Remap, FlexLUT } from './types.ts';

export interface PlanGlyph {
  char?: string;
  /** Outline in font units (SVG-down). Identical command structure across steps. */
  commands: PathCommand[];
  /** Ink bounds along x. */
  bounds: Bounds1D;
  advanceWidth: number;
  kernBefore: number;
  bbox: BBox;
  /** Straight-column weights in [0, 1] (straight-profile.ts), length = slices. */
  weights: Float32Array;
}

export interface WidthStep {
  glyphs: PlanGlyph[];
  /** Run width Σ(kernBefore + advanceWidth) in font units. */
  width: number;
  /** User-space axis location of this instance (diagnostics). */
  location?: Record<string, number>;
}

export interface WidthPlan {
  /** Instances sorted by ascending run width (≥ 1). */
  steps: WidthStep[];
  /** Index of the resting instance (stretch 1). */
  base: number;
  /** Virtual stretchy measure of each inter-glyph gap when widening, font units. */
  tracking: number;
}

/** Default `tracking`: a tenth of an em per gap (comparable to one glyph's straight measure). */
export function defaultTracking(unitsPerEm: number): number {
  return unitsPerEm / 10;
}

export interface WidthFrame {
  /** Blend between steps[k0] and steps[k1] by t (k0 === k1 ⇒ a single step). */
  k0: number;
  k1: number;
  t: number;
  /** Residual growth of the stretchy measure on steps[k1] (0 inside the ladder). */
  growth: number;
  /** True when the requested width could not be reached without distortion. */
  saturated: boolean;
}

/**
 * Residual slopes of one glyph: extra font units per unit of `growth`.
 * `lead` is added before the ink (the trailing half of the previous gap),
 * `ink` across the straight columns, `trail` after it (the leading half of
 * the next gap, plus the whole advance of a word space).
 */
export interface GlyphSlopes {
  lead: number;
  ink: number;
  trail: number;
}

export function runWidth(glyphs: ReadonlyArray<Pick<PlanGlyph, 'advanceWidth' | 'kernBefore'>>): number {
  let w = 0;
  for (const g of glyphs) w += (g.kernBefore ?? 0) + g.advanceWidth;
  return w;
}

/** Straight measure of a glyph's ink: Σ weight · sliceWidth. */
export function straightMeasure(g: Pick<PlanGlyph, 'bounds' | 'weights'>): number {
  const N = g.weights.length;
  const W = g.bounds.max - g.bounds.min;
  if (!(W > 0) || N === 0) return 0;
  let s = 0;
  for (let i = 0; i < N; i++) s += g.weights[i];
  return (s * W) / N;
}

/**
 * Slopes of glyph `i` of a run. `tracking` is the per-gap measure (pass 0 for
 * compression: straight columns only).
 */
export function glyphSlopes(glyphs: ReadonlyArray<PlanGlyph>, i: number, tracking: number): GlyphSlopes {
  const g = glyphs[i];
  const n = glyphs.length;
  const hasInk = g.bounds.max > g.bounds.min;
  const half = tracking / 2;
  return {
    lead: i > 0 ? half : 0,
    ink: hasInk ? straightMeasure(g) : 0,
    trail: (i < n - 1 ? half : 0) + (hasInk || tracking === 0 ? 0 : g.advanceWidth),
  };
}

/** Total stretchy measure M of a step (growth g adds g·M to the run width). */
export function stretchyMeasure(glyphs: ReadonlyArray<PlanGlyph>, tracking: number): number {
  let m = 0;
  for (let i = 0; i < glyphs.length; i++) {
    const s = glyphSlopes(glyphs, i, tracking);
    m += s.lead + s.ink + s.trail;
  }
  return m;
}

/** Tracking in effect for a growth direction (widening only). */
export function trackingFor(plan: WidthPlan, growth: number): number {
  return growth > 0 ? plan.tracking : 0;
}

/** Most a stretchy unit may shrink under compression (keeps every slice > 0). */
const MIN_GROWTH = -0.999;

/** Resolve a stretch ratio to the instance blend + residual growth. */
export function resolveFrame(plan: WidthPlan, stretch: number): WidthFrame {
  const steps = plan.steps;
  const last = steps.length - 1;
  const target = stretch * steps[plan.base].width;
  if (last > 0 && target > steps[0].width && target < steps[last].width) {
    let k = 0;
    while (k < last - 1 && steps[k + 1].width <= target) k++;
    const w0 = steps[k].width;
    const w1 = steps[k + 1].width;
    const t = w1 > w0 ? (target - w0) / (w1 - w0) : 0;
    return { k0: k, k1: k + 1, t, growth: 0, saturated: false };
  }
  const k = target >= steps[last].width ? last : 0;
  const step = steps[k];
  const need = target - step.width;
  const M = stretchyMeasure(step.glyphs, need > 0 ? plan.tracking : 0);
  if (Math.abs(need) < 1e-9) return { k0: k, k1: k, t: 0, growth: 0, saturated: false };
  if (!(M > 1e-6)) return { k0: k, k1: k, t: 0, growth: 0, saturated: true };
  let growth = need / M;
  let saturated = false;
  if (growth < MIN_GROWTH) {
    growth = MIN_GROWTH;
    saturated = true;
  }
  return { k0: k, k1: k, t: 0, growth, saturated };
}

/**
 * Column remap for one glyph under residual growth: slice i has width
 * w·(1 + growth·weights[i]). Same `Remap` shape as core/lut.ts buildRemap, so
 * the SVG tier's exact split/serialize path consumes it unchanged.
 */
export function buildWeightedRemap(weights: Float32Array, bounds: Bounds1D, growth: number): Remap {
  const N = weights.length;
  const { min, max } = bounds;
  const W = max - min;
  const w = W / N;
  const e = new Float64Array(N);
  for (let i = 0; i < N; i++) e[i] = w * growth * weights[i];
  const boundaries = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) boundaries[i] = min + i * w;
  const sb = new Float64Array(N + 1);
  sb[0] = min;
  for (let i = 0; i < N; i++) sb[i + 1] = sb[i] + w + e[i];

  function remap(x: number): number {
    if (!(W > 0)) return x;
    const u = (x - min) / W;
    if (u <= 0) return sb[0] + u * (w + e[0]) * N;
    if (u >= 1) return sb[N] + (u - 1) * (w + e[N - 1]) * N;
    const f = u * N;
    const i = Math.min(N - 1, Math.floor(f));
    return sb[i] + (f - i) * (w + e[i]);
  }
  function toNormalizedLUT(): FlexLUT {
    const total = sb[N] - sb[0];
    const lut = new Float32Array(N + 1);
    for (let i = 0; i <= N; i++) lut[i] = total === 0 ? i / N : (sb[i] - sb[0]) / total;
    lut[0] = 0;
    lut[N] = 1;
    return lut;
  }
  return { remap, boundaries, stretchedBoundaries: sb, extras: e, sliceWidth: w, toNormalizedLUT };
}

/**
 * Normalized cumulative straight weight C(u) as an (N+1) LUT: the shape of a
 * glyph's ink growth (its magnitude is `GlyphSlopes.ink`). An all-zero profile
 * yields the identity ramp; it is never used because its ink slope is 0.
 */
export function cumulativeWeights(weights: Float32Array): FlexLUT {
  const N = weights.length;
  const C = new Float32Array(N + 1);
  let sum = 0;
  for (let i = 0; i < N; i++) sum += weights[i];
  if (sum < 1e-9) {
    for (let i = 0; i <= N; i++) C[i] = i / N;
    return C;
  }
  let acc = 0;
  for (let i = 0; i < N; i++) {
    acc += weights[i];
    C[i + 1] = acc / sum;
  }
  C[0] = 0;
  C[N] = 1;
  return C;
}

export interface FrameGlyph {
  /** Pen origin: draw outline point (x, y) at (penX + X(x), y). */
  penX: number;
  /** Interpolated outline (blend frames) — already in glyph space. */
  commands: PathCommand[] | null;
  /** Column remap (residual frames, growth ≠ 0), else null. */
  remap: Remap | null;
  /** Ink left/right in run space. */
  inkLeft: number;
  inkRight: number;
}

export interface FrameLayout {
  glyphs: FrameGlyph[];
  width: number;
  frame: WidthFrame;
}

function lerpCommands(a: PathCommand[], b: PathCommand[], t: number): PathCommand[] {
  if (t <= 0 || a === b) return a;
  if (t >= 1) return b;
  const out: PathCommand[] = new Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = b[i] ?? p;
    const c: PathCommand = { type: p.type };
    if (p.x !== undefined) c.x = p.x + t * ((q.x ?? p.x) - p.x);
    if (p.y !== undefined) c.y = p.y + t * ((q.y ?? p.y) - p.y);
    if (p.x1 !== undefined) c.x1 = p.x1 + t * ((q.x1 ?? p.x1) - p.x1);
    if (p.y1 !== undefined) c.y1 = p.y1 + t * ((q.y1 ?? p.y1) - p.y1);
    if (p.x2 !== undefined) c.x2 = p.x2 + t * ((q.x2 ?? p.x2) - p.x2);
    if (p.y2 !== undefined) c.y2 = p.y2 + t * ((q.y2 ?? p.y2) - p.y2);
    out[i] = c;
  }
  return out;
}

/** Lay the run out for a resolved frame (CPU path; the SVG tier and tests). */
export function layoutFrame(plan: WidthPlan, frame: WidthFrame, origin = 0): FrameLayout {
  const s0 = plan.steps[frame.k0];
  const s1 = plan.steps[frame.k1];
  const t = frame.k0 === frame.k1 ? 0 : frame.t;
  const g = frame.growth;
  const out: FrameGlyph[] = [];
  let cursor = origin;
  const n = s0.glyphs.length;
  for (let i = 0; i < n; i++) {
    const a = s0.glyphs[i];
    const b = s1.glyphs[i] ?? a;
    if (g !== 0) {
      // residual frame on a single step (k0 === k1)
      const sl = glyphSlopes(s1.glyphs, i, trackingFor(plan, g));
      cursor += b.kernBefore;
      const penX = cursor + g * sl.lead;
      const hasInk = b.bounds.max > b.bounds.min;
      const remap = hasInk ? buildWeightedRemap(b.weights, b.bounds, g) : null;
      const inkLeft = penX + b.bounds.min;
      const inkRight = penX + (remap ? remap.remap(b.bounds.max) : b.bounds.max);
      out.push({ penX, commands: null, remap, inkLeft, inkRight });
      cursor += b.advanceWidth + g * (sl.lead + sl.ink + sl.trail);
      continue;
    }
    cursor += a.kernBefore + t * (b.kernBefore - a.kernBefore);
    const penX = cursor;
    const commands = lerpCommands(a.commands, b.commands, t);
    const min = a.bounds.min + t * (b.bounds.min - a.bounds.min);
    const max = a.bounds.max + t * (b.bounds.max - a.bounds.max);
    out.push({ penX, commands, remap: null, inkLeft: penX + min, inkRight: penX + max });
    cursor += a.advanceWidth + t * (b.advanceWidth - a.advanceWidth);
  }
  return { glyphs: out, width: cursor - origin, frame };
}

/**
 * Per-glyph residual slopes in RUN space for step `k` (font units per unit of
 * growth): the ink's left edge moves by growth·left and the ink widens by
 * growth·ink·C(u), C = cumulativeWeights(weights). This is exactly what
 * layoutFrame + buildWeightedRemap do on the CPU, in the linear-in-growth form
 * the WebGL vertex shader evaluates.
 */
export function residualSlopes(plan: WidthPlan, k: number, growth: number): Array<{ left: number; ink: number }> {
  const glyphs = plan.steps[k].glyphs;
  const tracking = trackingFor(plan, growth);
  const out: Array<{ left: number; ink: number }> = [];
  let acc = 0;
  for (let i = 0; i < glyphs.length; i++) {
    const sl = glyphSlopes(glyphs, i, tracking);
    out.push({ left: acc + sl.lead, ink: sl.ink });
    acc += sl.lead + sl.ink + sl.trail;
  }
  return out;
}

/** Widest run the plan can draw up to `maxStretch` (for static viewBox / surface sizing). */
export function maxRunWidth(plan: WidthPlan, maxStretch: number): number {
  const f = resolveFrame(plan, Math.max(1, maxStretch));
  return Math.max(plan.steps[plan.base].width, layoutFrame(plan, f).width);
}

/** A one-step plan (static font, or no width axis): residual only. */
export function singleStepPlan(glyphs: PlanGlyph[], tracking: number): WidthPlan {
  return { steps: [{ glyphs, width: runWidth(glyphs) }], base: 0, tracking };
}
