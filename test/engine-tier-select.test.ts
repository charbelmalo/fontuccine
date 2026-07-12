/**
 * engine-tier-select.test.ts — PURE dispatch logic (no DOM).
 *
 * Locks the RESEARCH §3/§3.1 order: WebGL primary, VF opportunistic (only when
 * WebGL absent), SVG for reduced-motion/print/compression/no-GL, and graceful
 * forced-tier fall-through with a recorded note.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTier } from '../src/engine/tier-select.ts';
import type { TierCaps } from '../src/engine/tier-select.ts';

const base: TierCaps = {
  webgl2: true,
  vfSupported: true,
  reducedMotion: false,
  print: false,
  compression: false,
};

test('auto → WebGL when WebGL2 present and no static/compression flags', () => {
  assert.equal(selectTier('auto', base).tier, 'webgl');
});

test('auto → VF only when WebGL2 absent and VF usable (opportunistic)', () => {
  const d = selectTier('auto', { ...base, webgl2: false });
  assert.equal(d.tier, 'vf');
  assert.match(d.notes.join(' '), /VF \(opportunistic/);
});

test('auto → SVG when no WebGL2 and no VF', () => {
  assert.equal(selectTier('auto', { ...base, webgl2: false, vfSupported: false }).tier, 'svg');
});

test('auto → SVG under reduced motion even with WebGL2', () => {
  const d = selectTier('auto', { ...base, reducedMotion: true });
  assert.equal(d.tier, 'svg');
  assert.match(d.notes.join(' '), /reduced-motion/);
});

test('auto → SVG under print even with WebGL2', () => {
  assert.equal(selectTier('auto', { ...base, print: true }).tier, 'svg');
});

test('auto → SVG for compression (minStretchRatio<1) even with WebGL2', () => {
  const d = selectTier('auto', { ...base, compression: true });
  assert.equal(d.tier, 'svg');
  assert.match(d.notes.join(' '), /compression/);
});

test("forced 'webgl' honored when supported; falls through to auto when not", () => {
  assert.equal(selectTier('webgl', base).tier, 'webgl');
  const d = selectTier('webgl', { ...base, webgl2: false });
  assert.equal(d.tier, 'vf'); // auto order with no WebGL → VF
  assert.match(d.notes.join(' '), /forced tier 'webgl' unavailable/);
});

test("forced 'vf' declines on a non-wdth font → falls through to auto + notes", () => {
  const d = selectTier('vf', { ...base, vfSupported: false });
  assert.equal(d.tier, 'webgl'); // auto with WebGL present
  assert.match(d.notes.join(' '), /forced tier 'vf' declined/);
});

test("forced 'svg' always resolves to SVG (vector-fidelity opt-in)", () => {
  assert.equal(selectTier('svg', base).tier, 'svg');
  assert.equal(selectTier('svg', { ...base, webgl2: false, vfSupported: false }).tier, 'svg');
});
