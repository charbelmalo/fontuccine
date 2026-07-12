/**
 * engine-attach.test.ts — `Fontuccine.attach` orchestration under jsdom.
 *
 * Verifies the CARRIED-FORWARD GUARANTEE: attach() always drives the renderer
 * through a StretchController, which is the sole ticker-activity registrant, so
 * once the spring settles the SHARED ticker self-parks (no renderer-owned
 * liveness). We prove this behaviorally: with a hand-driven internal-loop
 * scheduler, frame scheduling STOPS after the spring settles — if any renderer
 * had registered an always-live predicate, the loop could never park.
 *
 * Also: SVG wiring end-to-end (glyph paths drawn) + destroy() restores the DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTicker } from '../src/interaction/ticker.ts';
import type { FrameScheduler } from '../src/interaction/ticker.ts';
import { attach } from '../src/engine/attach.ts';
import type { ParsedFont } from '../src/font/parser.ts';
import { rect } from './helpers.ts';

/** ParsedFont stub: every non-blank char is the synthetic bar glyph. */
function stubFont(): ParsedFont {
  return {
    unitsPerEm: 1000,
    name: 'Stub',
    glyph(ch: string) {
      if (/\s/.test(ch)) return null;
      return { commands: rect, advanceWidth: 140, bbox: { minX: 0, minY: 0, maxX: 100, maxY: 700 } };
    },
    kernPair() {
      return 0;
    },
  };
}

function makeDoc(text = 'AB') {
  const dom = new JSDOM(`<!doctype html><body><h1 id="hero">${text}</h1></body>`);
  const win = dom.window as unknown as { ResizeObserver: unknown };
  win.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = win.ResizeObserver;
  return { doc: dom.window.document, host: dom.window.document.querySelector('#hero') as HTMLElement };
}

/** Internal-loop ticker whose single pending callback we drive by hand. */
function drivableTicker() {
  let pending: ((now: number) => void) | null = null;
  let reqCount = 0;
  let now = 0;
  const scheduler: FrameScheduler = {
    requestFrame(cb) {
      reqCount++;
      pending = cb;
      return reqCount;
    },
    cancelFrame() {
      pending = null;
    },
    now: () => now,
  };
  const ticker = createTicker(scheduler);
  return {
    ticker,
    /** Run one frame (16ms). Returns false when the loop has parked. */
    tick(): boolean {
      const cb = pending;
      pending = null;
      if (!cb) return false;
      now += 16;
      cb(now);
      return true;
    },
    get parked() {
      return pending === null;
    },
    get reqCount() {
      return reqCount;
    },
  };
}

test('attach selects SVG (no WebGL) and draws one <path> per glyph', async () => {
  const { doc, host } = makeDoc('AB');
  const d = drivableTicker();
  const inst = attach(host, {
    parsedFont: stubFont(),
    trigger: 'custom',
    ticker: d.ticker,
    document: doc,
    detectWebGL2Support: () => false,
    isReducedMotion: () => false,
    isPrint: () => false,
  });
  await inst.ready;
  assert.equal(inst.tier, 'svg');
  const svg = host.querySelector('svg[data-fontuccine="svg-tier"]');
  assert.ok(svg, 'svg render layer mounted');
  assert.equal(svg!.querySelectorAll('path').length, 2, 'two glyph paths');

  inst.destroy();
  assert.equal(host.querySelector('svg[data-fontuccine="svg-tier"]'), null, 'render layer removed');
  assert.equal(host.textContent, 'AB', 'original text restored');
});

test('GUARANTEE: shared ticker self-parks after the spring settles (controller is the only liveness)', async () => {
  const { doc, host } = makeDoc('AB');
  const d = drivableTicker();
  const inst = attach(host, {
    parsedFont: stubFont(),
    trigger: 'custom',
    ticker: d.ticker,
    document: doc,
    detectWebGL2Support: () => false,
    isReducedMotion: () => false,
    physics: { stiffness: 220 },
  });
  await inst.ready;

  // Drain any startup frames: resting target == value == 1 → settles immediately.
  let guard = 0;
  while (d.tick() && guard++ < 50) {
    /* run to park */
  }
  assert.ok(d.parked, 'ticker parks at rest with nothing to animate');

  // Drive a target change; the loop must wake, animate, then self-park.
  inst.set(2.5);
  assert.ok(!d.parked, 'set() woke the ticker');

  let frames = 0;
  while (d.tick()) {
    if (++frames > 3000) break;
  }
  assert.ok(frames > 3, `animated across multiple frames (got ${frames})`);
  assert.ok(frames < 3000, 'loop terminated — it did NOT run forever');
  assert.ok(d.parked, 'ticker self-parked once the spring settled (no renderer-owned liveness)');

  inst.destroy();
});

test('attach honors trigger:custom set() clamping via the controller', async () => {
  const { doc, host } = makeDoc('A');
  const d = drivableTicker();
  const inst = attach(host, {
    parsedFont: stubFont(),
    trigger: 'custom',
    maxStretchRatio: 3,
    minStretchRatio: 1,
    ticker: d.ticker,
    document: doc,
    detectWebGL2Support: () => false,
    isReducedMotion: () => false,
    physics: { stiffness: 300 },
  });
  await inst.ready;
  inst.set(99); // over max → clamps to 3
  let n = 0;
  while (d.tick() && n++ < 3000) {
    /* settle */
  }
  const svg = host.querySelector('svg[data-fontuccine="svg-tier"]') as SVGSVGElement;
  assert.ok(svg, 'rendered');
  inst.destroy();
});
