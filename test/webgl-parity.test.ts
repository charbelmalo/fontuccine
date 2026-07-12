/**
 * webgl-parity.test.ts — the load-bearing cross-tier GEOMETRY PARITY proof
 * (CLAUDE.md rule 3; task DoD "identical letterform geometry — same LUT").
 *
 * The GPU never runs in Node, so we prove the WebGL tier reproduces the SVG
 * tier's stretched geometry by mirroring the vertex shader's arithmetic
 * (src/webgl/parity.ts) and diffing it against the frozen core remap that the
 * SVG tier's on-curve positions equal (buildRemap + layoutRun). Real font
 * glyphs at 1× / 2.5× / 4.5×; deviation must be float-noise.
 *
 * Also asserts: (a) the shader's static `inkLeft = origin + stretch·glyphOrigin`
 * reconstruction equals layoutRun's inkLeft, so no per-frame attribute upload is
 * needed; (b) the two-tap LUT sampling equals a direct piecewise evaluation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleOutline, sampleBounds } from '../src/core/sampling/outline.ts';
import { computeFlexProfile } from '../src/core/flex-profile.ts';
import { layoutRun } from '../src/core/kerning.ts';
import type { LayoutGlyph } from '../src/core/kerning.ts';
import type { PathCommand } from '../src/core/types.ts';
import {
  buildFlexCumulative,
  gpuRemapX,
  glyphOriginFactor,
  sampleNormalizedLUT,
} from '../src/webgl/parity.ts';
import { loadSystemFont, stems, rect } from './helpers.ts';

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
  return { flex, bounds, advanceWidth: bb.maxX + 40 };
}

interface Analyzed {
  commands?: PathCommand[];
  flex: Float32Array;
  bounds: { min: number; max: number };
  advanceWidth: number;
  kernBefore?: number;
}

/** Max |GPU remap − SVG/core remap| over sampled x, across a run of glyphs. */
function measureRunParity(glyphs: Analyzed[], stretch: number): number {
  const layoutGlyphs: LayoutGlyph[] = glyphs.map((g) => ({
    profile: g.flex,
    bounds: g.bounds,
    advanceWidth: g.advanceWidth,
    kernBefore: g.kernBefore,
  }));
  const layout = layoutRun(layoutGlyphs, { stretch, axis: 'x', origin: 0 });

  let maxDev = 0;
  // static prefixAdvance accumulator (mirrors the shader attribute derivation)
  let prefix = 0;
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    const res = layout.glyphs[i];
    const cum = buildFlexCumulative(g.flex);

    // (a) static inkLeft reconstruction matches layoutRun.
    prefix += g.kernBefore ?? 0;
    const originFactor = glyphOriginFactor(prefix, g.bounds.min);
    const inkLeftGpu = 0 + stretch * originFactor;
    assert.ok(
      Math.abs(inkLeftGpu - res.inkLeft) < 1e-6,
      `inkLeft[${i}] gpu ${inkLeftGpu} vs layout ${res.inkLeft}`,
    );
    prefix += g.advanceWidth;

    // (b) remap parity across the glyph frame. The vertex shader only ever
    // evaluates box coords ∈ [0,1] (u ∈ [0,1]); glyph on-curve points live in
    // [min,max] by construction, so that is the only meaningful domain. Outside
    // it the core does slope-of-end-slice extrapolation while the GPU clamps the
    // cumulative LUT flat — a region the shader never reaches (documented in
    // parity.ts). Sample sub-slice to catch any interpolation drift.
    const { min, max } = g.bounds;
    const W = max - min;
    const STEPS = SLICES * 3;
    for (let k = 0; k <= STEPS; k++) {
      const x = min + (k / STEPS) * W;
      const svg = res.penX + res.remap.remap(x);
      const gpu = gpuRemapX(cum, x, min, max, res.inkLeft, stretch);
      maxDev = Math.max(maxDev, Math.abs(svg - gpu));
    }
  }
  return maxDev;
}

test('two-tap LUT sampling equals direct piecewise evaluation', () => {
  const { flex } = analyzeX(stems);
  const cum = buildFlexCumulative(flex);
  const N = cum.length - 1;
  let maxDev = 0;
  for (let s = 0; s <= 500; s++) {
    const u = s / 500;
    // direct piecewise-linear over the same (N+1) samples
    const f = Math.min(N, Math.max(0, u * N));
    const i = Math.min(N - 1, Math.floor(f));
    const t = f - i;
    const direct = cum[i] * (1 - t) + cum[i + 1] * t;
    maxDev = Math.max(maxDev, Math.abs(direct - sampleNormalizedLUT(cum, u)));
  }
  assert.ok(maxDev < 1e-7, `LUT two-tap deviation ${maxDev.toExponential(3)}`);
});

test('GPU remap == SVG/core remap on synthetic twin stems (stretch ≥ 1)', () => {
  for (const stretch of [1, 1.8, 2.5, 4.5]) {
    const dev = measureRunParity([analyzeX(stems), analyzeX(rect)], stretch);
    assert.ok(dev < 1e-4, `stems+rect @${stretch}× deviation ${dev.toExponential(3)} font units`);
  }
});

test('GPU remap == SVG/core remap on a real-font RUN R-B-O-S @1×/2.5×/4.5×', () => {
  const sys = loadSystemFont();
  if (!sys) {
    // Synthetic fallback keeps the invariant covered on font-less CI.
    for (const stretch of [1, 2.5, 4.5]) {
      const dev = measureRunParity([analyzeX(stems)], stretch);
      assert.ok(dev < 1e-4, `fallback @${stretch}× dev ${dev.toExponential(3)}`);
    }
    return;
  }
  const chars = ['R', 'B', 'O', 'S'];
  const glyphs: Analyzed[] = [];
  for (let i = 0; i < chars.length; i++) {
    const parsed = sys.font.glyph(chars[i]);
    if (!parsed) continue;
    const a = analyzeX(parsed.commands);
    glyphs.push({
      commands: parsed.commands,
      flex: a.flex,
      bounds: a.bounds,
      advanceWidth: parsed.advanceWidth,
      kernBefore: i === 0 ? 0 : sys.font.kernPair(chars[i - 1], chars[i]),
    });
  }
  assert.ok(glyphs.length >= 2, 'need at least two real glyphs');

  let worst = 0;
  for (const stretch of [1, 2.5, 4.5]) {
    const dev = measureRunParity(glyphs, stretch);
    worst = Math.max(worst, dev);
    assert.ok(dev < 1e-3, `real run @${stretch}× deviation ${dev.toExponential(3)} font units`);
  }
  // Report the measured envelope (visible with `node --test` verbose).
  assert.ok(worst >= 0, `max cross-tier deviation ${worst.toExponential(3)} font units`);
});
