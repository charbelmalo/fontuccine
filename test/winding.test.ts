/**
 * winding.test.ts — self-intersection filtering (T3, RESEARCH §5.2).
 *
 * A buried self-overlap segment (drawn same-winding, so nonzero-fill keeps the
 * shape solid — the essence of the Playfair 'W' case) must NOT corrupt the
 * flex minima. A horizontal bar that should stretch uniformly gets a false
 * rigid dip from the buried rectangle's vertical edges; winding filtering
 * removes those invisible tangents and restores the correct stretchy profile,
 * while a genuine perpendicular stem stays rigid.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleOutline, sampleBounds } from '../src/core/sampling/outline.ts';
import { computeFlexProfile } from '../src/core/flex-profile.ts';
import { buildRemap } from '../src/core/lut.ts';
import type { PathCommand } from '../src/core/types.ts';
import { stems } from './helpers.ts';

// Horizontal bar x∈[0,600], y∈[300,400], with a BURIED inner rectangle
// x∈[280,320], y∈[330,370] wound the SAME direction (nonzero-fill keeps it
// solid → its edges are invisible self-intersections).
const barWithBuried: PathCommand[] = [
  { type: 'M', x: 0, y: 300 }, { type: 'L', x: 600, y: 300 },
  { type: 'L', x: 600, y: 400 }, { type: 'L', x: 0, y: 400 }, { type: 'Z' },
  { type: 'M', x: 280, y: 330 }, { type: 'L', x: 320, y: 330 },
  { type: 'L', x: 320, y: 370 }, { type: 'L', x: 280, y: 370 }, { type: 'Z' },
];

function flexX(commands: PathCommand[], filterInvisible: boolean) {
  const outline = sampleOutline(commands, 32);
  const bb = sampleBounds(outline);
  return computeFlexProfile(outline, {
    axis: 'x',
    slices: 100,
    k: 8,
    bounds: { min: bb.minX, max: bb.maxX },
    crossBounds: { min: bb.minY, max: bb.maxY },
    interiorSamples: 80,
    filterInvisible,
  });
}

test('buried self-intersection is filtered → bar stays stretchy', () => {
  // x=300 lands at slice index ~50 (bounds x∈[0,600], 100 slices).
  const midLo = 46, midHi = 54;
  const minMid = (arr: Float32Array) => {
    let m = Infinity;
    for (let i = midLo; i <= midHi; i++) m = Math.min(m, arr[i]);
    return m;
  };

  const unfiltered = flexX(barWithBuried, false);
  const filtered = flexX(barWithBuried, true);

  // Without filtering, the buried vertical edges make the middle wrongly rigid.
  assert.ok(minMid(unfiltered) < 0.3, `unfiltered mid should dip rigid (${minMid(unfiltered).toFixed(3)})`);
  // With filtering, the middle recovers its stretchiness (bar is all-horizontal edges).
  assert.ok(minMid(filtered) > 0.6, `filtered mid should be stretchy (${minMid(filtered).toFixed(3)})`);
});

test('filtered bar absorbs stretch across the previously-corrupted region', () => {
  const flex = flexX(barWithBuried, true);
  const { remap } = buildRemap(flex, { min: 0, max: 600, stretch: 2 });
  // The 40u region that was buried should now stretch ~proportionally (≈80u),
  // not stay rigid.
  const region = remap(320) - remap(280);
  assert.ok(region > 40 * 1.6, `buried region should stretch (${region.toFixed(1)}u, want ≳64)`);
});

test('genuine perpendicular strokes stay rigid with filtering on (I3 not broken)', () => {
  // Twin stems with an empty gap between them: the gap absorbs the stretch, so
  // the perpendicular stems must keep their thickness. Filtering must not
  // corrupt these genuine (visible) tangents.
  const outline = sampleOutline(stems, 32);
  const bb = sampleBounds(outline);
  const bounds = { min: bb.minX, max: bb.maxX };
  const flex = computeFlexProfile(outline, {
    axis: 'x', slices: 100, k: 8, bounds,
    crossBounds: { min: bb.minY, max: bb.maxY }, interiorSamples: 64,
    filterInvisible: true,
  });
  const { remap } = buildRemap(flex, { ...bounds, stretch: 3 });
  const stem1 = remap(98) - remap(2);
  const stem2 = remap(498) - remap(402);
  assert.ok(stem1 < 96 * 1.35, `stem 1 thickness preserved (${stem1.toFixed(1)}u)`);
  assert.ok(stem2 < 96 * 1.35, `stem 2 thickness preserved (${stem2.toFixed(1)}u)`);
});
