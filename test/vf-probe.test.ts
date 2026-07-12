/**
 * vf-probe.test.ts — Tier-0 capability probe + stretch→wdth mapping (pure).
 *
 * Asserts:
 *  - the exact ratio→percentage mapping and clamp at BOTH axis bounds;
 *  - SUPPORTED for an in-range wdth font, with the axis + mapping returned;
 *  - DECLINE for (a) no wdth axis, (b) requested range beyond the axis,
 *    (c) a non-horizontal requested axis.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeTier0, createWdthMapping } from '../src/vf/probe.ts';
import type { WdthAxis } from '../src/vf/detect.ts';

const axis: WdthAxis = { min: 75, default: 100, max: 125 };

// ---- mapping + clamp ---------------------------------------------------------

test('createWdthMapping maps ratio→percentage and clamps at both axis bounds', () => {
  const m = createWdthMapping(axis);
  assert.equal(m.toPercent(1), 100, 'ratio 1 → 100%');
  assert.equal(m.toPercent(1.25), 125, 'ratio 1.25 → 125% (axis max, exact)');
  assert.equal(m.toPercent(0.75), 75, 'ratio 0.75 → 75% (axis min, exact)');
  assert.ok(Math.abs(m.toPercent(1.1) - 110) < 1e-9, 'interior value passes through as r×100');
  // clamp beyond the designed range in BOTH directions
  assert.equal(m.toPercent(4.5), 125, 'over-stretch clamps to axis max');
  assert.equal(m.toPercent(0.1), 75, 'over-compress clamps to axis min');
});

// ---- support decision --------------------------------------------------------

test('probeTier0 SUPPORTED when the requested range fits the axis', () => {
  const d = probeTier0(axis, { maxStretchRatio: 1.25, minStretchRatio: 0.75, axis: 'horizontal' });
  assert.equal(d.supported, true);
  if (d.supported) {
    assert.deepEqual(d.axis, axis);
    assert.equal(d.mapping.toPercent(1.25), 125);
  }
});

test('probeTier0 SUPPORTED at the exact axis boundary (float-clean 1.25)', () => {
  const d = probeTier0(axis, { maxStretchRatio: 1.25 });
  assert.equal(d.supported, true, 'maxStretchRatio == axis.max/100 must not spuriously decline');
});

test('probeTier0 DECLINE: no wdth axis', () => {
  const d = probeTier0(null, { maxStretchRatio: 1.1 });
  assert.equal(d.supported, false);
  if (!d.supported) assert.equal(d.reason, 'no-wdth-axis');
});

test('probeTier0 DECLINE: requested max exceeds the axis range', () => {
  // default maxStretchRatio is 4.5 — way past a 125% axis → must fall through.
  const d = probeTier0(axis, {});
  assert.equal(d.supported, false);
  if (!d.supported) assert.equal(d.reason, 'range-exceeds-axis');
});

test('probeTier0 DECLINE: requested min compresses past the axis range', () => {
  const d = probeTier0(axis, { maxStretchRatio: 1.2, minStretchRatio: 0.5 }); // 0.5 < 75/100
  assert.equal(d.supported, false);
  if (!d.supported) assert.equal(d.reason, 'range-exceeds-axis');
});

test('probeTier0 DECLINE: non-horizontal axis requested (wdth is horizontal-only)', () => {
  const vertical = probeTier0(axis, { maxStretchRatio: 1.2, axis: 'vertical' });
  assert.equal(vertical.supported, false);
  if (!vertical.supported) assert.equal(vertical.reason, 'non-horizontal-axis');

  const dual = probeTier0(axis, { maxStretchRatio: 1.2, axis: 'dual' });
  assert.equal(dual.supported, false);
});

test('probeTier0 defaults axis to horizontal and minStretchRatio to 1', () => {
  // condensed-capable axis; default min (1) fits since axis.min/100 = 0.75 <= 1
  const d = probeTier0(axis, { maxStretchRatio: 1.25 });
  assert.equal(d.supported, true);
});
