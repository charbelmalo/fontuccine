/**
 * webgl-stretch-guard.test.ts — regression gate for the Tier-1 SUB-UNITY guard.
 *
 * BUG (QA-measured): the stretch-independent LUT form `u + (stretch-1)·C(u)` is
 * exact and monotonic for stretch ≥ 1, but has NO lower guard. For stretch < 1
 * the term `(stretch-1)·C'(u)` goes negative and, where the cumulative flex C is
 * steep (high-flex-concentration glyphs — real 'W', punctuation '.'), the remap
 * derivative `1 + (stretch-1)·C'(u)` drops below 0 → the letterform FOLDS OVER
 * (I5 / monotonicity violation). QA measured fold-over from stretch 0.9,
 * unbounded to -16 font-unit inversions at 0.25×.
 *
 * TWO reachable paths put stretch < 1 on the GPU:
 *   1. config `minStretchRatio < 1` → sustained compression reaches the shader
 *      (here: the reduced-motion static-draw `restingStretch` path);
 *   2. an underdamped spring undershooting its resting target — the controller
 *      emits `.value` UNCLAMPED (QA measured a release-to-1 spring dip to 0.38).
 *
 * FIX: the WebGL tier is stretch-ONLY; compression is the SVG (vector-fidelity)
 * tier's job (RESEARCH §3). The renderer clamps any stretch < 1 to identity (1)
 * at the GPU draw boundary (src/webgl/renderer.ts, `paint`/`draw`). This test
 * proves the guard holds on BOTH paths and that the resulting GPU geometry stays
 * monotonic. It FAILS if the clamp is removed (Part B reads the exact value that
 * reaches `run.draw`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTicker } from '../src/interaction/ticker.ts';
import type { FrameScheduler, Ticker } from '../src/interaction/ticker.ts';
import { sampleOutline, sampleBounds } from '../src/core/sampling/outline.ts';
import { computeFlexProfile } from '../src/core/flex-profile.ts';
import { buildFlexCumulative, gpuRemapX } from '../src/webgl/parity.ts';
import type { FlexLUT } from '../src/core/types.ts';
import type { PathCommand } from '../src/core/types.ts';
import { createWebglRenderer } from '../src/webgl/renderer.ts';
import type { WebglGlyph } from '../src/webgl/types.ts';
import { MsdfClient } from '../src/webgl/msdf/client.ts';
import type {
  RenderBackend,
  RunHandle,
  GlyphRunData,
  FrameParams,
} from '../src/webgl/gl/device.ts';
import { loadSystemFont } from './helpers.ts';

const SLICES = 96;

// The two sub-unity drive values QA measured reaching the GPU, plus a mild dip.
const SUB_UNITY = [0.9, 0.5, 0.38, 0.25];

// ── adversarial geometry ────────────────────────────────────────────────────

/** Analyze a glyph outline into (normalized cumulative flex, ink bounds). */
function analyze(commands: PathCommand[]): { cum: FlexLUT; min: number; max: number } {
  const outline = sampleOutline(commands, 32);
  const bb = sampleBounds(outline);
  const flex = computeFlexProfile(outline, {
    axis: 'x',
    slices: SLICES,
    k: 8,
    bounds: { min: bb.minX, max: bb.maxX },
    crossBounds: { min: bb.minY, max: bb.maxY },
    interiorSamples: 48,
    smooth: 0.75,
  });
  return { cum: buildFlexCumulative(flex), min: bb.minX, max: bb.maxX };
}

/**
 * Synthetic high-flex-concentration glyph: nearly-rigid everywhere with a single
 * dominant flex spike. Its cumulative C jumps ~1.0 over one slice, so the local
 * slope C'(u) ≈ N — enormously exceeding the fold thresholds (C'>1/(1-s): 2.0 at
 * s=0.5, ~1.6 at s=0.38, ~1.33 at s=0.25). A deterministic stand-in for the
 * concentrated flex of a real 'W' / '.' that folds without a system font.
 */
function syntheticSpike(): { cum: FlexLUT; min: number; max: number } {
  const flex = new Float32Array(SLICES).fill(1e-3);
  flex[Math.floor(SLICES * 0.42)] = 50;
  return { cum: buildFlexCumulative(flex), min: 0, max: 100 };
}

/** Strictly-non-decreasing check of the GPU remap across the whole glyph frame. */
function foldsOver(g: { cum: FlexLUT; min: number; max: number }, stretch: number): boolean {
  const STEPS = 4000;
  const W = g.max - g.min;
  let prev = -Infinity;
  for (let k = 0; k <= STEPS; k++) {
    const x = g.min + (k / STEPS) * W;
    const y = gpuRemapX(g.cum, x, g.min, g.max, 0, stretch);
    if (y < prev - 1e-9) return true; // went backwards → folded/inverted
    prev = y;
  }
  return false;
}

/** The tier-safe floor the renderer applies at the GPU draw boundary. */
const tierClamp = (raw: number): number => Math.max(1, raw);

// Adversarial set: the guaranteed synthetic spike, plus real 'W' and '.' when a
// system font is available (QA's measured worst offenders).
function adversarialGlyphs(): Array<{ label: string; g: ReturnType<typeof analyze> }> {
  const set = [{ label: 'synthetic-spike', g: syntheticSpike() }];
  const sys = loadSystemFont();
  if (sys) {
    for (const ch of ['W', '.']) {
      const parsed = sys.font.glyph(ch);
      if (parsed && parsed.commands.length) {
        set.push({ label: `real '${ch}'`, g: analyze(parsed.commands) });
      }
    }
  }
  return set;
}

// ── Part A: the hazard is real, and the clamp neutralizes it (pure geometry) ──

test('sub-unity stretch FOLDS adversarial geometry — the clamp target', () => {
  const g = syntheticSpike();
  // Sanity: identity and stretch never fold.
  assert.equal(foldsOver(g, 1), false, 'identity is monotonic');
  assert.equal(foldsOver(g, 2.5), false, 'stretch ≥ 1 is monotonic');
  // Every reachable sub-unity drive folds this glyph — this is the bug.
  for (const s of SUB_UNITY) {
    assert.equal(foldsOver(g, s), true, `raw stretch ${s} must fold (proves the hazard)`);
  }
});

test('tier clamp yields MONOTONIC GPU geometry on all adversarial glyphs', () => {
  for (const { label, g } of adversarialGlyphs()) {
    for (const raw of SUB_UNITY) {
      const clamped = tierClamp(raw);
      assert.equal(clamped, 1, `clamp maps ${raw} → identity`);
      assert.equal(
        foldsOver(g, clamped),
        false,
        `${label}: clamped(${raw})=${clamped} must stay monotonic (no fold-over)`,
      );
    }
  }
});

// ── Part B: the guard holds at the ACTUAL GPU draw boundary (renderer) ────────
// These read the `stretch` that reaches `run.draw`. They FAIL if the clamp is
// removed from the renderer.

class MockRun implements RunHandle {
  draws = 0;
  lastParams: FrameParams | null = null;
  upload(_d: GlyphRunData): void {}
  draw(p: FrameParams): void {
    this.draws++;
    this.lastParams = p;
  }
  dispose(): void {}
}

class MockBackend implements RenderBackend {
  readonly supported = true;
  readonly canvas: HTMLCanvasElement;
  contextCreationCount = 1;
  runs: MockRun[] = [];
  constructor(doc: Document) {
    this.canvas = doc.createElement('canvas');
  }
  isContextLost(): boolean {
    return false;
  }
  ensureSize(): void {}
  ensureAtlas(): void {}
  uploadAtlasCell(): void {}
  beginFrame(): void {}
  setNoise(): void {}
  createRun(): RunHandle {
    const r = new MockRun();
    this.runs.push(r);
    return r;
  }
  onContextLost(): () => void {
    return () => {};
  }
  onContextRestored(): () => void {
    return () => {};
  }
  destroy(): void {}
}

function makeDoc(text = 'W') {
  const dom = new JSDOM(`<!doctype html><body><h1 id="hero">${text}</h1></body>`);
  const w = dom.window as unknown as Record<string, unknown>;
  w.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = w.ResizeObserver;
  return { doc: dom.window.document, host: dom.window.document.querySelector('#hero') as HTMLElement };
}

function manualTicker(): Ticker {
  const scheduler: FrameScheduler = { requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 };
  return createTicker(scheduler);
}

function spikeGlyph(): WebglGlyph {
  const commands: PathCommand[] = [
    { type: 'M', x: 0, y: 0 },
    { type: 'L', x: 100, y: 0 },
    { type: 'L', x: 100, y: 700 },
    { type: 'L', x: 0, y: 700 },
    { type: 'Z' },
  ];
  const bb = sampleBounds(sampleOutline(commands, 24));
  const flex = new Float32Array(SLICES).fill(1e-3);
  flex[Math.floor(SLICES * 0.42)] = 50; // high-flex concentration (fold-prone)
  return {
    char: 'W',
    commands,
    flex,
    bounds: { min: bb.minX, max: bb.maxX },
    advanceWidth: bb.maxX + 40,
    bbox: bb,
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test('animated tier: sub-unity controller value never reaches run.draw (guard)', async () => {
  // Covers path 2 (underdamped spring undershoot: 0.38) AND generic sub-unity.
  for (const value of [0.5, 0.38, 0.25]) {
    const { doc, host } = makeDoc();
    const backend = new MockBackend(doc);
    const ticker = manualTicker();
    const r = createWebglRenderer({
      host,
      glyphs: [spikeGlyph()],
      controller: { value, velocity: -1.2 }, // spring still moving, resting toward 1
      ticker,
      backend,
      msdfClient: new MsdfClient({ inline: true }),
    });
    r.attach();
    await settle();
    ticker.frame(1); // animated tier draws on the frame
    const run = backend.runs[0];
    assert.ok(run && run.lastParams, `a frame was drawn for value ${value}`);
    assert.ok(
      run.lastParams.stretch >= 1,
      `controller.value ${value} must be clamped ≥ 1 at run.draw, got ${run.lastParams.stretch}`,
    );
    assert.equal(run.lastParams.stretch, 1, 'clamped exactly to identity');
    r.destroy();
  }
});

test('static tier: config restingStretch < 1 never reaches run.draw (guard)', async () => {
  // Covers path 1 (config minStretchRatio < 1) via the reduced-motion static draw.
  for (const resting of [0.5, 0.25]) {
    const { doc, host } = makeDoc();
    const backend = new MockBackend(doc);
    const r = createWebglRenderer({
      host,
      glyphs: [spikeGlyph()],
      controller: { value: resting },
      ticker: manualTicker(),
      backend,
      msdfClient: new MsdfClient({ inline: true }),
      isReducedMotion: () => true,
      restingStretch: resting,
    });
    r.attach();
    await settle();
    const run = backend.runs[0];
    assert.ok(run && run.lastParams, 'one static draw happened');
    assert.ok(
      run.lastParams.stretch >= 1,
      `restingStretch ${resting} must be clamped ≥ 1 at run.draw, got ${run.lastParams.stretch}`,
    );
    r.destroy();
  }
});
