/**
 * kerning.test.ts — advances + kerning in stretched space (T6).
 *
 *  - stretch === 1 reproduces native pen positions/advances EXACTLY.
 *  - total run width = stretch · Σ(advanceWidth + kernBefore).
 *  - pen advance is monotonic non-decreasing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleOutline, sampleBounds } from '../src/core/sampling/outline.ts';
import { computeFlexProfile } from '../src/core/flex-profile.ts';
import { layoutRun } from '../src/core/kerning.ts';
import type { LayoutGlyph } from '../src/core/kerning.ts';
import { rect } from './helpers.ts';

function makeGlyphs(): LayoutGlyph[] {
  const outline = sampleOutline(rect, 32);
  const bb = sampleBounds(outline);
  const bounds = { min: bb.minX, max: bb.maxX };
  const crossBounds = { min: bb.minY, max: bb.maxY };
  const profile = computeFlexProfile(outline, { axis: 'x', slices: 96, k: 8, bounds, crossBounds });
  // Glyphs with realistic side bearings (bounds within a wider advance) + kerns.
  return [
    { profile, bounds: { min: 20, max: 120 }, advanceWidth: 140, kernBefore: 0 },
    { profile, bounds: { min: 15, max: 115 }, advanceWidth: 130, kernBefore: 8 },
    { profile, bounds: { min: 25, max: 125 }, advanceWidth: 150, kernBefore: 12 },
  ];
}

test('stretch === 1 reproduces native metrics exactly', () => {
  const glyphs = makeGlyphs();
  const run = layoutRun(glyphs, { axis: 'x', stretch: 1 });

  // Reconstruct the native pen walk.
  let cursor = 0;
  glyphs.forEach((g, i) => {
    cursor += g.kernBefore ?? 0;
    const r = run.glyphs[i];
    assert.equal(r.penX, cursor, `penX[${i}]`);
    assert.equal(r.advance, g.advanceWidth, `advance[${i}]`);
    // ink edges = native
    assert.ok(Math.abs(r.inkLeft - (cursor + g.bounds.min)) < 1e-9, `inkLeft[${i}]`);
    assert.ok(Math.abs(r.inkRight - (cursor + g.bounds.max)) < 1e-9, `inkRight[${i}]`);
    cursor += g.advanceWidth;
  });

  const nativeWidth = glyphs.reduce((s, g) => s + g.advanceWidth + (g.kernBefore ?? 0), 0);
  assert.ok(Math.abs(run.width - nativeWidth) < 1e-9, 'run width == native');
});

test('total run width scales by stretch (conservation)', () => {
  const glyphs = makeGlyphs();
  const stretch = 2.5;
  const run = layoutRun(glyphs, { axis: 'x', stretch });
  const nativeWidth = glyphs.reduce((s, g) => s + g.advanceWidth + (g.kernBefore ?? 0), 0);
  assert.ok(Math.abs(run.width - nativeWidth * stretch) < 1e-6, `width ${run.width} vs ${nativeWidth * stretch}`);

  // Also equals Σ(stretched advance + stretched kern).
  const summed = run.glyphs.reduce((s, r) => s + r.advance + r.kern, 0);
  assert.ok(Math.abs(run.width - summed) < 1e-6, 'width == Σ(advance+kern)');
});

test('pen advance is monotonic non-decreasing', () => {
  const run = layoutRun(makeGlyphs(), { axis: 'x', stretch: 3 });
  for (let i = 1; i < run.glyphs.length; i++) {
    assert.ok(run.glyphs[i].penX >= run.glyphs[i - 1].penX, `penX monotonic at ${i}`);
  }
});
