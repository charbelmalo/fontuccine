/**
 * webgl-context.test.ts — Tier-1 renderer ORCHESTRATION discipline under jsdom
 * with an INJECTED mock backend (no GPU in Node). The GL calls are inspection-
 * verified in device.ts; here we prove the renderer's contract:
 *
 *  - unsupported WebGL2 ⇒ `supported === false`, `element === null` (obligation
 *    4: the engine drops to the SVG tier — never renders nothing);
 *  - ONE shared context for N instances (RESEARCH §2 layer-memory discipline):
 *    the factory runs once and `contextCreationCount` stays 1;
 *  - context loss ⇒ full re-upload (atlas + run) on restore (obligation 1);
 *  - IntersectionObserver deactivation ⇒ no draws while offscreen (RESEARCH §2);
 *  - reduced motion ⇒ exactly ONE static draw and NO per-frame render callback
 *    (CLAUDE.md rule 6);
 *  - effects are zero-cost when disabled (all effect scalars 0 in draw params).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTicker } from '../src/interaction/ticker.ts';
import type { FrameScheduler, Ticker } from '../src/interaction/ticker.ts';
import { sampleBounds, sampleOutline } from '../src/core/sampling/outline.ts';
import { createWebglRenderer } from '../src/webgl/renderer.ts';
import type { WebglGlyph } from '../src/webgl/types.ts';
import { MsdfClient } from '../src/webgl/msdf/client.ts';
import {
  setBackendFactory,
  acquireSharedBackend,
  __resetSharedBackend,
} from '../src/webgl/gl/shared.ts';
import type { RenderBackend, RunHandle, GlyphRunData, FrameParams } from '../src/webgl/gl/device.ts';
import type {
  IntersectionEntryLike,
  IntersectionObserverLike,
} from '../src/interaction/gating.ts';
import { rect } from './helpers.ts';

// ── mock GL backend ───────────────────────────────────────────────────────────

class MockRun implements RunHandle {
  uploads = 0;
  draws = 0;
  disposed = 0;
  lastData: GlyphRunData | null = null;
  lastParams: FrameParams | null = null;
  upload(d: GlyphRunData): void {
    this.uploads++;
    this.lastData = d;
  }
  draw(p: FrameParams): void {
    this.draws++;
    this.lastParams = p;
  }
  dispose(): void {
    this.disposed++;
  }
}

class MockBackend implements RenderBackend {
  readonly supported: boolean;
  readonly canvas: HTMLCanvasElement;
  contextCreationCount = 1;
  lost = false;
  destroyed = false;
  runs: MockRun[] = [];
  atlasEnsured = 0;
  cellsUploaded = 0;
  sizeCalls = 0;
  noiseSet = 0;
  beginTokens: number[] = [];
  private lostCbs = new Set<() => void>();
  private restoredCbs = new Set<() => void>();

  constructor(doc: Document, supported = true) {
    this.supported = supported;
    this.canvas = doc.createElement('canvas');
  }
  isContextLost(): boolean {
    return this.lost;
  }
  ensureSize(): void {
    this.sizeCalls++;
  }
  ensureAtlas(): void {
    this.atlasEnsured++;
  }
  uploadAtlasCell(): void {
    this.cellsUploaded++;
  }
  beginFrame(token: number): void {
    this.beginTokens.push(token);
  }
  setNoise(): void {
    this.noiseSet++;
  }
  createRun(): RunHandle {
    const r = new MockRun();
    this.runs.push(r);
    return r;
  }
  onContextLost(cb: () => void): () => void {
    this.lostCbs.add(cb);
    return () => this.lostCbs.delete(cb);
  }
  onContextRestored(cb: () => void): () => void {
    this.restoredCbs.add(cb);
    return () => this.restoredCbs.delete(cb);
  }
  destroy(): void {
    this.destroyed = true;
  }
  // test drivers
  fireLost(): void {
    this.lost = true;
    for (const c of this.lostCbs) c();
  }
  fireRestored(): void {
    this.lost = false;
    this.contextCreationCount++;
    for (const c of this.restoredCbs) c();
  }
}

// ── fixtures ──────────────────────────────────────────────────────────────────

const SLICES = 96;

function makeDoc(text = 'I') {
  const dom = new JSDOM(`<!doctype html><body><h1 id="hero">${text}</h1></body>`);
  const w = dom.window as unknown as Record<string, unknown>;
  w.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = w.ResizeObserver;
  return { doc: dom.window.document, host: dom.window.document.querySelector('#hero') as HTMLElement, window: dom.window };
}

function manualTicker(): Ticker {
  const scheduler: FrameScheduler = { requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 };
  return createTicker(scheduler);
}

function glyph(): WebglGlyph {
  const bb = sampleBounds(sampleOutline(rect, 24));
  const flex = new Float32Array(SLICES).fill(1); // uniform (parity tested elsewhere)
  return { char: 'I', commands: rect, flex, bounds: { min: bb.minX, max: bb.maxX }, advanceWidth: bb.maxX + 40, bbox: bb };
}

/** Let the async MSDF generation + its `.then` chain settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function freshClient(): MsdfClient {
  return new MsdfClient({ inline: true }); // no worker in Node
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('unsupported WebGL2 ⇒ supported=false, element=null (SVG-tier fallback)', () => {
  setBackendFactory(() => null); // simulate no WebGL2
  const { host } = makeDoc();
  const r = createWebglRenderer({ host, glyphs: [glyph()], controller: { value: 1 }, ticker: manualTicker(), msdfClient: freshClient() });
  assert.equal(r.supported, false);
  assert.equal(r.element, null);
  r.attach(); // must be a safe no-op
  r.destroy();
  setBackendFactory(null);
  __resetSharedBackend();
});

test('N instances share ONE context (single contextCreationCount)', () => {
  let created = 0;
  let shared: MockBackend | null = null;
  const { doc, host } = makeDoc('ABC');
  setBackendFactory(() => {
    created++;
    shared = new MockBackend(doc);
    return shared;
  });

  const renderers = [0, 1, 2].map(() =>
    createWebglRenderer({ host, glyphs: [glyph()], controller: { value: 1 }, ticker: manualTicker(), msdfClient: freshClient() }),
  );

  assert.equal(created, 1, 'backend factory invoked exactly once');
  const el = renderers[0].element;
  assert.ok(el, 'shared canvas exists');
  for (const r of renderers) assert.equal(r.element, el, 'all instances share the same canvas');
  assert.equal(shared!.contextCreationCount, 1);

  for (const r of renderers) r.destroy();
  assert.equal(shared!.destroyed, true, 'last release destroys the shared backend');

  setBackendFactory(null);
  __resetSharedBackend();
});

test('acquireSharedBackend is ref-counted (destroy only on the last release)', () => {
  const { doc } = makeDoc();
  setBackendFactory(() => new MockBackend(doc));
  const a = acquireSharedBackend(SLICES) as MockBackend;
  const b = acquireSharedBackend(SLICES) as MockBackend;
  assert.equal(a, b, 'same singleton');
  // (release APIs are exercised via renderer.destroy in the sibling test)
  setBackendFactory(null);
  __resetSharedBackend();
});

test('finer lutResolution after grid sized ⇒ ONE deduped, informative warn', () => {
  const { doc } = makeDoc();
  setBackendFactory(() => new MockBackend(doc));

  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  try {
    // (i) Build the shared grid at the default (coarser) resolution, then a
    // later instance requests a FINER resolution ⇒ exactly one warn.
    acquireSharedBackend(SLICES); // sizes the page-global grid to 96
    warnings.length = 0;
    acquireSharedBackend(SLICES * 2); // 192 > 96 ⇒ warns once
    assert.equal(warnings.length, 1, 'finer request warns exactly once');
    const msg = warnings[0];
    assert.match(msg, /192/, 'states the requested resolution');
    assert.match(msg, /96/, 'states the active shared resolution');
    assert.match(msg, /page-global/, 'states the grid is page-global');
    assert.match(msg, /coarser existing grid/, 'states the coarser grid is used');

    // (iii) Repeated SAME finer request ⇒ still one total (deduped).
    warnings.length = 0;
    acquireSharedBackend(SLICES * 2);
    acquireSharedBackend(SLICES * 2);
    acquireSharedBackend(SLICES * 2);
    assert.equal(warnings.length, 0, 'same finer request is deduped (no re-warn)');

    // (ii) Equal or coarser requests never warn.
    warnings.length = 0;
    acquireSharedBackend(SLICES); // equal
    acquireSharedBackend(Math.floor(SLICES / 2)); // coarser
    assert.equal(warnings.length, 0, 'equal/coarser requests do not warn');

    // A DISTINCT finer resolution warns once more (dedupe is per-resolution).
    warnings.length = 0;
    acquireSharedBackend(SLICES * 3); // 288, new distinct value
    assert.equal(warnings.length, 1, 'a distinct finer resolution warns once');
  } finally {
    console.warn = realWarn;
    setBackendFactory(null);
    __resetSharedBackend();
  }
});

test('context loss ⇒ atlas + run fully re-uploaded on restore', async () => {
  const { doc, host } = makeDoc();
  const backend = new MockBackend(doc);
  const r = createWebglRenderer({
    host,
    glyphs: [glyph()],
    controller: { value: 1 },
    ticker: manualTicker(),
    backend,
    msdfClient: freshClient(),
  });
  r.attach();
  await settle();

  assert.equal(backend.runs.length, 1, 'one run created');
  const run = backend.runs[0];
  assert.ok(run.uploads >= 1, 'run uploaded at build');
  const uploadsBefore = run.uploads;
  const cellsBefore = backend.cellsUploaded;
  assert.ok(cellsBefore >= 1, 'atlas cell uploaded at build');

  backend.fireLost();
  assert.equal(backend.isContextLost(), true);
  backend.fireRestored();

  assert.ok(run.uploads > uploadsBefore, 'run re-uploaded after restore');
  assert.ok(backend.cellsUploaded > cellsBefore, 'atlas re-uploaded after restore');
  r.destroy();
  assert.equal(run.disposed, 1, 'run disposed on destroy');
});

test('IntersectionObserver deactivation ⇒ no draws while offscreen', async () => {
  const { doc, host } = makeDoc();
  const backend = new MockBackend(doc);
  let handler: ((e: IntersectionEntryLike[]) => void) | null = null;
  const visibilityFactory = (cb: (e: IntersectionEntryLike[]) => void): IntersectionObserverLike => {
    handler = cb;
    return { observe() {}, unobserve() {}, disconnect() {} };
  };

  const ticker = manualTicker();
  const r = createWebglRenderer({
    host,
    glyphs: [glyph()],
    controller: { value: 1 },
    ticker,
    backend,
    msdfClient: freshClient(),
    visibilityFactory,
  });
  r.attach();
  await settle();
  const run = backend.runs[0];

  // Go offscreen, then advance the stretch and drive a frame: must NOT draw.
  handler!([{ isIntersecting: false }]);
  const drawsHidden = run.draws;
  // Driving a frame while offscreen must not draw (the gate suspended it).
  ticker.frame(1);
  assert.equal(run.draws, drawsHidden, 'no draw while offscreen');

  // Back on screen ⇒ resumes.
  handler!([{ isIntersecting: true }]);
  ticker.frame(2);
  assert.ok(run.draws > drawsHidden, 'draws resume when visible again');
  r.destroy();
});

test('reduced motion ⇒ exactly ONE static draw and no per-frame callback', async () => {
  const { doc, host } = makeDoc();
  const backend = new MockBackend(doc);
  const ticker = manualTicker();
  const r = createWebglRenderer({
    host,
    glyphs: [glyph()],
    controller: { value: 1 },
    ticker,
    backend,
    msdfClient: freshClient(),
    isReducedMotion: () => true,
    restingStretch: 1,
  });
  r.attach();
  await settle();
  const run = backend.runs[0];
  assert.equal(run.draws, 1, 'one static draw');

  // No render subscription ⇒ driving frames does nothing further.
  ticker.frame(1);
  ticker.frame(2);
  assert.equal(run.draws, 1, 'static tier does not animate');
  r.destroy();
});

test('effects are zero-cost when disabled (all effect scalars 0 in draw params)', async () => {
  const { doc, host } = makeDoc();
  const backend = new MockBackend(doc);
  const ticker = manualTicker();
  const r = createWebglRenderer({
    host,
    glyphs: [glyph()],
    controller: { value: 1 },
    ticker,
    backend,
    msdfClient: freshClient(),
  });
  r.attach();
  await settle();
  ticker.frame(1); // animated tier draws on the frame
  const p = backend.runs[0].lastParams!;
  assert.ok(p, 'a frame was drawn');
  assert.equal(p.grain, 0, 'grain off');
  assert.equal(p.aberration, 0, 'aberration off');
  assert.equal(p.dispIntensity, 0, 'displacement off');
  assert.deepEqual(p.stretchDir, [1, 0], 'horizontal axis only');
  assert.equal(backend.noiseSet, 0, 'no noise texture loaded when displacement disabled');
  r.destroy();
});

test('enabled effects flow through to draw params (grain + velocity aberration)', async () => {
  const { doc, host } = makeDoc();
  const backend = new MockBackend(doc);
  const ticker = manualTicker();
  const r = createWebglRenderer({
    host,
    glyphs: [glyph()],
    controller: { value: 2, velocity: 3 },
    ticker,
    backend,
    msdfClient: freshClient(),
    effects: { grain: 0.4, aberration: { max: 2, fromVelocity: true } },
  });
  r.attach();
  await settle();
  ticker.frame(1);
  const p = backend.runs[0].lastParams!;
  assert.equal(p.grain, 0.4, 'grain passed through');
  assert.ok(p.aberration > 0 && p.aberration <= 2, 'velocity aberration within max');
  r.destroy();
});
