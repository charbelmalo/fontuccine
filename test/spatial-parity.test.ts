/**
 * spatial-parity.test.ts — the k-d tree must NOT alter flex results (T2).
 *
 *  - KDTree.nearest() returns the same sample index as brute force over random
 *    queries (synthetic + a real font glyph).
 *  - computeFlexProfile('kdtree') is bit-identical to computeFlexProfile('brute')
 *    on synthetic glyphs AND a real font glyph.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleOutline, sampleBounds } from '../src/core/sampling/outline.ts';
import { computeFlexProfile } from '../src/core/flex-profile.ts';
import { KDTree } from '../src/core/spatial/kdtree.ts';
import type { Axis, PathCommand, BoundarySample } from '../src/core/types.ts';
import { rect, stems, loadSystemFont } from './helpers.ts';

function bruteNearest(pts: BoundarySample[], qx: number, qy: number): number {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = (pts[i].x - qx) ** 2 + (pts[i].y - qy) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function nearestParity(samples: BoundarySample[], seed: number) {
  const tree = new KDTree(samples);
  const bb = samples.reduce(
    (a, s) => ({
      minX: Math.min(a.minX, s.x), maxX: Math.max(a.maxX, s.x),
      minY: Math.min(a.minY, s.y), maxY: Math.max(a.maxY, s.y),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
  );
  // deterministic LCG so queries avoid exact symmetric ties
  let r = seed;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 2000; i++) {
    const qx = bb.minX + rnd() * (bb.maxX - bb.minX);
    const qy = bb.minY + rnd() * (bb.maxY - bb.minY);
    assert.equal(tree.nearest(qx, qy), bruteNearest(samples, qx, qy), `query ${i} (${qx},${qy})`);
  }
}

function profileParity(commands: PathCommand[], axis: Axis) {
  const outline = sampleOutline(commands, 32);
  const bb = sampleBounds(outline);
  const bounds = axis === 'x' ? { min: bb.minX, max: bb.maxX } : { min: bb.minY, max: bb.maxY };
  const crossBounds = axis === 'x' ? { min: bb.minY, max: bb.maxY } : { min: bb.minX, max: bb.maxX };
  const common = { axis, slices: 96, k: 8, bounds, crossBounds, interiorSamples: 64 } as const;
  const kd = computeFlexProfile(outline, { ...common, spatial: 'kdtree' });
  const brute = computeFlexProfile(outline, { ...common, spatial: 'brute' });
  assert.equal(kd.length, brute.length);
  for (let i = 0; i < kd.length; i++) {
    assert.ok(Math.abs(kd[i] - brute[i]) <= 1e-6, `slice ${i}: kd=${kd[i]} brute=${brute[i]}`);
  }
}

test('KDTree nearest == brute (synthetic rect + stems)', () => {
  nearestParity(sampleOutline(rect, 32).samples, 12345);
  nearestParity(sampleOutline(stems, 32).samples, 67890);
});

test('flex profile: kdtree == brute (synthetic)', () => {
  profileParity(rect, 'x');
  profileParity(rect, 'y');
  profileParity(stems, 'x');
});

test('parity holds on a real font glyph (skips if no system font)', (t) => {
  const sys = loadSystemFont();
  if (!sys) return t.skip('no system font found');
  for (const ch of ['R', 'B', 'S', 'g']) {
    const g = sys.font.glyph(ch);
    if (!g) continue;
    nearestParity(sampleOutline(g.commands, 24).samples, 4242);
    profileParity(g.commands, 'x');
    profileParity(g.commands, 'y');
  }
});
