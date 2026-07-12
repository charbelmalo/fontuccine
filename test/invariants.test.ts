/**
 * invariants.test.ts — production port of ALL 17 invariants from
 * refs/examples/test-invariants.mjs, run against src/core (not the refs).
 *
 * I5's non-inversion check runs against `stretchedBoundaries` (the ref's
 * `boundaries` was stretched-space; the production contract makes `boundaries`
 * ORIGINAL-space for the SVG tier, and exposes stretched positions separately).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleOutline, sampleBounds } from '../src/core/sampling/outline.ts';
import { computeFlexProfile } from '../src/core/flex-profile.ts';
import { buildRemap } from '../src/core/lut.ts';
import type { Axis } from '../src/core/types.ts';
import { rect, stems } from './helpers.ts';

const approx = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

function analyze(commands: typeof rect, axis: Axis, opts: Record<string, unknown> = {}) {
  const outline = sampleOutline(commands, 32);
  const bb = sampleBounds(outline);
  const bounds = axis === 'x' ? { min: bb.minX, max: bb.maxX } : { min: bb.minY, max: bb.maxY };
  const crossBounds = axis === 'x' ? { min: bb.minY, max: bb.maxY } : { min: bb.minX, max: bb.maxX };
  const flex = computeFlexProfile(outline, {
    axis, slices: 100, k: 8, bounds, crossBounds, interiorSamples: 64, ...opts,
  });
  return { flex, bounds };
}

test('I1/I6 — bar ⟂ to stretch (horizontal 2×): uniform degradation', () => {
  const { flex, bounds } = analyze(rect, 'x');
  const { remap } = buildRemap(flex, { ...bounds, stretch: 2 });
  const W = bounds.max - bounds.min;
  assert.ok(approx(remap(bounds.max) - remap(bounds.min), W * 2, 1e-6), 'I1 total extent');
  assert.ok(approx(remap(55) - remap(45), 20, 2.5), `I6 stroke-only → ~uniform (${(remap(55) - remap(45)).toFixed(2)})`);
});

test('I1/I2/I3/I4 — bar ∥ to stretch (vertical 2×): stem elongation', () => {
  const { flex, bounds } = analyze(rect, 'y');
  const stretch = 2.0;
  const { remap } = buildRemap(flex, { ...bounds, stretch });

  assert.ok(approx(remap(700) - remap(0), 700 * stretch, 1e-6), 'I1 total extent');

  let monotonic = true, prev = -Infinity;
  for (let y = 0; y <= 700; y += 1) {
    const v = remap(y);
    if (v < prev - 1e-9) { monotonic = false; break; }
    prev = v;
  }
  assert.ok(monotonic, 'I2 monotonic');

  const bottomCap = remap(40) - remap(0);
  const topCap = remap(700) - remap(660);
  assert.ok(bottomCap < 40 * 1.35, `I3 bottom cap (${bottomCap.toFixed(1)})`);
  assert.ok(topCap < 40 * 1.35, `I3 top cap (${topCap.toFixed(1)})`);

  const shaft = remap(400) - remap(300);
  assert.ok(shaft > 100 * 1.7, `I4 shaft absorbs (${shaft.toFixed(1)})`);
});

test('I1/I3/I4 — twin stems, horizontal 3×', () => {
  const { flex, bounds } = analyze(stems, 'x');
  const stretch = 3.0;
  const { remap } = buildRemap(flex, { ...bounds, stretch });

  assert.ok(approx(remap(500) - remap(0), 500 * stretch, 1e-6), 'I1 total extent');

  const stem1 = remap(98) - remap(2);
  const stem2 = remap(498) - remap(402);
  assert.ok(stem1 < 96 * 1.35, `I3 stem 1 (${stem1.toFixed(1)})`);
  assert.ok(stem2 < 96 * 1.35, `I3 stem 2 (${stem2.toFixed(1)})`);

  const gap = remap(400) - remap(100);
  assert.ok(gap > 300 + 1000 * 0.7, `I4 gap absorbs (${gap.toFixed(1)})`);
});

test('I5 — compression 0.5× never inverts (stretched boundaries)', () => {
  const { flex, bounds } = analyze(rect, 'x');
  const { remap, stretchedBoundaries } = buildRemap(flex, { ...bounds, stretch: 0.5 });
  let inverted = false;
  for (let i = 1; i < stretchedBoundaries.length; i++) {
    if (stretchedBoundaries[i] - stretchedBoundaries[i - 1] <= 0) { inverted = true; break; }
  }
  assert.ok(!inverted, 'I5 no inversion under compression');
  assert.ok(
    approx(remap(bounds.max) - remap(bounds.min), (bounds.max - bounds.min) * 0.5, 1e-3),
    'I5 total extent halved',
  );
});

test('I6 — fully rigid profile degrades to uniform', () => {
  const flex = new Float32Array(50).fill(0);
  const { remap } = buildRemap(flex, { min: 0, max: 100, stretch: 2 });
  assert.ok(approx(remap(50), 100, 1e-6), `I6 uniform fallback (${remap(50)})`);
  assert.ok(approx(remap(100), 200, 1e-6), 'I6 total extent kept');
});

test('LUT — normalized GPU LUT starts at 0, ends at 1, monotonic', () => {
  const { flex, bounds } = analyze(stems, 'x');
  const r = buildRemap(flex, { ...bounds, stretch: 2 });
  const lut = r.toNormalizedLUT();
  assert.ok(lut[0] === 0 && approx(lut[lut.length - 1], 1, 1e-6), 'LUT 0→1');
  let mono = true;
  for (let i = 1; i < lut.length; i++) if (lut[i] < lut[i - 1]) { mono = false; break; }
  assert.ok(mono, 'LUT monotonic (GPU-safe)');
});
