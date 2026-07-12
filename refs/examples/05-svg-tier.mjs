/**
 * 05-svg-tier.mjs — Fontuccine Tier-2 (SVG) reference sketch
 *
 * KEY INSIGHT (this makes the SVG tier EXACT, not approximate):
 * The LUT remap is piecewise AFFINE — linear within each slice. If every
 * bézier segment is first SPLIT at the slice boundaries it crosses
 * (bezier.js `.split(t)`, de Casteljau), each sub-segment lies entirely
 * inside one slice, where the remap is an affine map. Affine maps of bézier
 * control points transform the curve EXACTLY. So:
 *
 *     split at slice boundaries  →  remap control points  →  exact result
 *
 * This replaces the RFC's hand-wavy "inject extra anchor points" with a
 * closed-form procedure. No visual approximation, no dense flattening
 * (unlike demo 08, which flattens for output simplicity).
 *
 * Per frame: only remapControlPoints() reruns (cheap); splitting reruns only
 * when the SLICE GRID changes (i.e., never — it's static per glyph).
 *
 * Not runnable standalone (requires `npm i bezier-js`); this documents the
 * production algorithm for the dom-render agent.
 */
import { Bezier } from 'bezier-js';

/**
 * Split one segment at every slice boundary it crosses, along one axis.
 * seg: {type:'L'|'Q'|'C', points:[{x,y},...]} — absolute coords
 * boundaries: ascending slice boundary coordinates from buildRemap().boundaries
 *             (ORIGINAL space: min + i*sliceWidth)
 */
export function splitAtSliceBoundaries(seg, boundaries, axis = 'x') {
  if (seg.type === 'L') {
    // lines can be split by simple interpolation — or left whole, since an
    // affine-per-slice map of a line crossing slices is still piecewise
    // linear; splitting keeps output segments exact primitives:
    return splitLine(seg, boundaries, axis);
  }
  const b = new Bezier(seg.points);
  // find t values where the segment crosses each boundary
  const ts = [];
  for (const bound of boundaries) {
    // roots of (axis(t) - bound): bezier-js gives extrema/roots per axis via
    // .intersects({p1,p2}) with a boundary line, or solve on the aligned poly
    const line = axis === 'x'
      ? { p1: { x: bound, y: -1e6 }, p2: { x: bound, y: 1e6 } }
      : { p1: { x: -1e6, y: bound }, p2: { x: 1e6, y: bound } };
    for (const t of b.intersects(line)) ts.push(Number(t));
  }
  ts.sort((a, z) => a - z);
  // de Casteljau split at each t (renormalizing t after each split)
  const parts = [];
  let rest = b, consumed = 0;
  for (const t of ts) {
    if (t <= consumed + 1e-9 || t >= 1 - 1e-9) continue;
    const local = (t - consumed) / (1 - consumed);
    const { left, right } = rest.split(local);
    parts.push(left);
    rest = right;
    consumed = t;
  }
  parts.push(rest);
  return parts.map((p) => ({ type: seg.type, points: p.points }));
}

function splitLine(seg, boundaries, axis) {
  const [p0, p1] = seg.points;
  const a0 = p0[axis], a1 = p1[axis];
  const ts = boundaries
    .map((bound) => (bound - a0) / (a1 - a0))
    .filter((t) => Number.isFinite(t) && t > 1e-9 && t < 1 - 1e-9)
    .sort((a, z) => a - z);
  const pts = [p0, ...ts.map((t) => ({
    x: p0.x + t * (p1.x - p0.x),
    y: p0.y + t * (p1.y - p0.y),
  })), p1];
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) out.push({ type: 'L', points: [pts[i], pts[i + 1]] });
  return out;
}

/**
 * PER FRAME: remap the control points of pre-split segments and serialize.
 * remapX/remapY come from buildRemap(flex, {min,max,stretch}).remap —
 * rebuilt each frame with the current stretch value (O(slices), trivial).
 */
export function serializeStretched(splitSegments, remapX, remapY) {
  let d = '';
  for (const contour of splitSegments) {
    contour.forEach((seg, i) => {
      const P = seg.points.map((p) => ({ x: remapX(p.x), y: remapY(p.y) }));
      if (i === 0) d += `M${fmt(P[0])}`;
      if (seg.type === 'L') d += `L${fmt(P[1])}`;
      else if (seg.type === 'Q') d += `Q${fmt(P[1])} ${fmt(P[2])}`;
      else d += `C${fmt(P[1])} ${fmt(P[2])} ${fmt(P[3])}`;
    });
    d += 'Z';
  }
  return d;
}
const fmt = (p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;

/*
 * Production notes (dom-render agent):
 * - Write `d` via element.setAttribute inside the ticker's WRITE phase only.
 *   SVG d mutation triggers paint per frame (C-tier) — budget accordingly:
 *   this tier is for headlines (≲ a few dozen glyphs), and is the automatic
 *   fallback when WebGL is unavailable.
 * - Reuse one <path> per glyph; never rebuild the node tree per frame.
 * - Dual axis: split against both axes' boundaries (grid cells), then remap
 *   x and y independently — still affine per cell, still exact.
 * - The <svg> replaces the element's rendered text; original text stays in
 *   the DOM visually-hidden for selection/SEO/a11y (engine invariant).
 */
