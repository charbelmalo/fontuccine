/**
 * svg-exactness.test.ts — the PURE, browser-free proof that the SVG tier is
 * mathematically EXACT (RESEARCH §3 Tier 2; refs/examples/05-svg-tier.mjs).
 *
 * For a real glyph, split its outline at slice boundaries, remap the pre-split
 * control points through `buildRemap`, then assert that evaluating the remapped
 * (control-point) sub-segment at any t equals the ANALYTICAL `remap()` of the
 * original on-curve point. Since Bézier curves are affine-invariant and the
 * remap is affine within a slice, the deviation must be at float-noise level.
 * This is the visual-regression seed: if `d` is ever produced by a non-exact
 * path, this deviation blows up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleOutline, sampleBounds } from '../src/core/sampling/outline.ts';
import { computeFlexProfile } from '../src/core/flex-profile.ts';
import { buildRemap } from '../src/core/lut.ts';
import { evalSegment } from '../src/core/geometry/segments.ts';
import type { Segment } from '../src/core/geometry/segments.ts';
import { splitGlyph, remapContours, interiorBoundaries } from '../src/svg/split.ts';
import type { PathCommand } from '../src/core/types.ts';
import { loadSystemFont, stems } from './helpers.ts';

const SLICES = 96;

function analyzeX(commands: PathCommand[]) {
  const outline = sampleOutline(commands, 32);
  const bb = sampleBounds(outline);
  const bounds = { min: bb.minX, max: bb.maxX };
  const flex = computeFlexProfile(outline, {
    axis: 'x',
    slices: SLICES,
    k: 8,
    bounds,
    crossBounds: { min: bb.minY, max: bb.maxY },
    interiorSamples: 48,
    smooth: 0.75,
  });
  return { flex, bounds };
}

/** Max |serialized − analytical remap| over sampled on-curve points, all glyphs. */
function measureDeviation(commands: PathCommand[], stretch: number): number {
  const { flex, bounds } = analyzeX(commands);
  const remap = buildRemap(flex, { ...bounds, stretch });
  const contours = splitGlyph(commands, bounds, SLICES);
  const mapped = remapContours(contours, remap, 0);

  let maxDev = 0;
  for (let c = 0; c < contours.length; c++) {
    for (let s = 0; s < contours[c].length; s++) {
      const orig: Segment = contours[c][s];
      const rseg: Segment = mapped[c][s];
      for (let k = 0; k <= 8; k++) {
        const t = k / 8;
        const op = evalSegment(orig, t);
        const rp = evalSegment(rseg, t);
        const analyticalX = remap.remap(op.x); // piecewise remap of the on-curve x
        maxDev = Math.max(maxDev, Math.abs(rp.x - analyticalX), Math.abs(rp.y - op.y));
      }
    }
  }
  return maxDev;
}

test('SVG tier is EXACT on synthetic twin stems (affine-per-slice)', () => {
  for (const stretch of [0.5, 1, 1.8, 2.5, 4.5]) {
    const dev = measureDeviation(stems, stretch);
    assert.ok(dev < 1e-6, `stems @${stretch}× deviation ${dev.toExponential(3)} (font units)`);
  }
});

test('SVG tier is EXACT on real font glyphs R/B/O/S/e/g @2.5×', () => {
  const sys = loadSystemFont();
  if (!sys) {
    console.log('  (skipped — no system font found)');
    return;
  }
  let worst = 0;
  for (const ch of ['R', 'B', 'O', 'S', 'a', 'e', 'g']) {
    const parsed = sys.font.glyph(ch);
    if (!parsed) continue;
    for (const stretch of [1, 2.5, 4.5]) {
      const dev = measureDeviation(parsed.commands, stretch);
      worst = Math.max(worst, dev);
      assert.ok(dev < 1e-4, `'${ch}' @${stretch}× deviation ${dev.toExponential(3)} (font units)`);
    }
  }
  // Values are ~1000 font units tall; 1e-4 absolute is ~1e-7 relative.
  console.log(`  max deviation across real glyphs: ${worst.toExponential(3)} font units`);
});

test('every split sub-segment lies within ONE slice (split invariant)', () => {
  const sys = loadSystemFont();
  const commands = sys?.font.glyph('R')?.commands ?? stems;
  const { bounds } = analyzeX(commands);
  const bnds = interiorBoundaries(bounds, SLICES);
  const w = (bounds.max - bounds.min) / SLICES;
  const contours = splitGlyph(commands, bounds, SLICES);

  for (const segs of contours) {
    for (const seg of segs) {
      // sample on-curve x range
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k <= 10; k++) {
        const x = evalSegment(seg, k / 10).x;
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
      // no interior boundary strictly between lo and hi (allow float slack)
      const crossed = bnds.some((b) => b > lo + 1e-6 && b < hi - 1e-6);
      assert.ok(!crossed, `sub-segment spans a boundary: [${lo.toFixed(2)}, ${hi.toFixed(2)}] (w=${w.toFixed(2)})`);
    }
  }
});

test('naive per-control-point remap distorts an escaping control point', () => {
  // Controlled proof of WHY we apply ONE slice affine per sub-segment instead
  // of remap()-ing each control point independently (the literal 05 sketch).
  // A quadratic whose curve stays in slice 5 [50,60) but whose control point
  // p1.x=66 escapes into slice 6 [60,70): the piecewise remap() maps p1 with
  // slice 6's affine, distorting the curve; the single-affine map does not.
  const bounds = { min: 0, max: 100 };
  const slices = 10; // width 10 per slice
  // non-uniform flex so adjacent slices have DIFFERENT affine slopes
  const flex = new Float32Array(slices);
  for (let i = 0; i < slices; i++) flex[i] = i % 2 === 0 ? 0.2 : 1.0;
  const remap = buildRemap(flex, { ...bounds, stretch: 3 });

  const seg: Segment = {
    type: 'Q',
    p0: { x: 52, y: 0 },
    p1: { x: 66, y: 40 }, // control point escapes into the next slice
    p2: { x: 52, y: 80 },
  };
  // curve x(t) peaks at t=0.5 → 0.25*52 + 0.5*66 + 0.25*52 = 59 (stays < 60)
  assert.ok(evalSegment(seg, 0.5).x < 60, 'curve stays inside slice 5');
  assert.ok(seg.p1.x >= 60, 'control point is in slice 6');

  const contours = [[seg]];
  const [mappedSeg] = remapContours(contours, remap, 0)[0];

  const naive: Segment = {
    type: 'Q',
    p0: { x: remap.remap(seg.p0.x), y: seg.p0.y },
    p1: { x: remap.remap(seg.p1.x), y: seg.p1.y },
    p2: { x: remap.remap(seg.p2.x), y: seg.p2.y },
  };

  let exactDev = 0;
  let naiveDev = 0;
  for (let k = 0; k <= 8; k++) {
    const t = k / 8;
    const target = remap.remap(evalSegment(seg, t).x); // analytical on-curve remap
    exactDev = Math.max(exactDev, Math.abs(evalSegment(mappedSeg, t).x - target));
    naiveDev = Math.max(naiveDev, Math.abs(evalSegment(naive, t).x - target));
  }
  console.log(`  single-affine dev ${exactDev.toExponential(2)} vs naive dev ${naiveDev.toFixed(3)}`);
  assert.ok(exactDev < 1e-9, `single-affine is exact (${exactDev.toExponential(2)})`);
  assert.ok(naiveDev > 0.5, `naive visibly distorts (${naiveDev.toFixed(3)})`);
});
