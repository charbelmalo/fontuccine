/**
 * lut-contract.test.ts — the FlexLUT contract (T5, cross-tier interface).
 *
 * assertLUT accepts every real buildRemap output (0→1, monotonic, length N+1)
 * and rejects malformed LUTs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleOutline, sampleBounds } from '../src/core/sampling/outline.ts';
import { computeFlexProfile } from '../src/core/flex-profile.ts';
import { buildRemap, assertLUT } from '../src/core/lut.ts';
import { rect, stems } from './helpers.ts';

function lutFor(commands: typeof rect, stretch: number) {
  const outline = sampleOutline(commands, 32);
  const bb = sampleBounds(outline);
  const bounds = { min: bb.minX, max: bb.maxX };
  const crossBounds = { min: bb.minY, max: bb.maxY };
  const flex = computeFlexProfile(outline, { axis: 'x', slices: 96, k: 8, bounds, crossBounds });
  return buildRemap(flex, { ...bounds, stretch });
}

test('assertLUT accepts real buildRemap outputs at many ratios', () => {
  for (const commands of [rect, stems]) {
    for (const stretch of [0.5, 0.8, 1, 1.5, 2, 4.5]) {
      const r = lutFor(commands, stretch);
      const lut = r.toNormalizedLUT();
      assert.equal(lut.length, r.boundaries.length, 'length N+1');
      assertLUT(lut); // throws on violation
      assert.equal(lut[0], 0);
      assert.ok(Math.abs(lut[lut.length - 1] - 1) <= 1e-6);
    }
  }
});

test('boundaries are ORIGINAL space, monotonic and uniform', () => {
  const r = lutFor(rect, 3);
  const b = r.boundaries;
  for (let i = 1; i < b.length; i++) {
    assert.ok(b[i] > b[i - 1], 'boundaries increasing');
    assert.ok(Math.abs(b[i] - b[i - 1] - r.sliceWidth) < 1e-6, 'uniform original slice width');
  }
});

test('assertLUT rejects malformed LUTs', () => {
  assert.throws(() => assertLUT(new Float32Array([0.1, 0.5, 1])), /must be 0/);
  assert.throws(() => assertLUT(new Float32Array([0, 0.5, 0.9])), /must be 1/);
  assert.throws(() => assertLUT(new Float32Array([0, 0.6, 0.4, 1])), /monotonic/);
  assert.throws(() => assertLUT(new Float32Array([0])), /length/);
  // @ts-expect-error wrong type on purpose
  assert.throws(() => assertLUT([0, 1]), /Float32Array/);
});
