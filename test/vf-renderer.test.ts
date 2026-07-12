/**
 * vf-renderer.test.ts — Tier-0 renderer discipline under jsdom + a manual ticker.
 *
 * Tier 0's a11y model DIFFERS from Tiers 1/2: it stretches the REAL native text
 * directly, so there is NO hidden-text overlay and NO aria-hidden render layer.
 * Verifies: native text is preserved (not moved/hidden/aria-hidden, no overlay);
 * `font-stretch` is written ONLY in the RENDER phase and clamped to the axis;
 * reduced motion paints resting ONCE with NO per-frame callback; wrap:nowrap sets
 * white-space; wrap:reserve reserves max-width from a READ-phase measurement;
 * the renderer registers NO activity predicate (StretchController owns liveness);
 * destroy() restores the host's inline style.
 *
 * The actual VISUAL width change from font-stretch/font-variation-settings is a
 * real-browser layout effect — verified BY INSPECTION, not here (jsdom has no
 * layout/font engine). These tests assert the STYLE WRITES + discipline only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTicker } from '../src/interaction/ticker.ts';
import type { FrameScheduler, Ticker } from '../src/interaction/ticker.ts';
import { createVfRenderer } from '../src/vf/renderer.ts';
import type { WdthAxis } from '../src/vf/detect.ts';

const axis: WdthAxis = { min: 75, default: 100, max: 125 };

function manualTicker(): Ticker {
  const scheduler: FrameScheduler = { requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 };
  return createTicker(scheduler);
}

function makeDoc(text = 'STRETCH') {
  const dom = new JSDOM(`<!doctype html><body><h1 id="hero">${text}</h1></body>`);
  const doc = dom.window.document;
  (dom.window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = (
    dom.window as unknown as { ResizeObserver: unknown }
  ).ResizeObserver;
  return { doc, host: doc.querySelector('#hero') as HTMLElement, window: dom.window };
}

test('native text is preserved: NOT moved, NOT hidden, NO overlay, NOT aria-hidden', () => {
  const { doc, host } = makeDoc('STRETCH');
  const controller = { value: 1 };
  const r = createVfRenderer({ host, axis, controller, ticker: manualTicker(), document: doc, isReducedMotion: () => false });
  r.attach();

  assert.equal(host.textContent, 'STRETCH', 'text intact & selectable in flow');
  assert.equal(host.querySelector('[data-fontuccine="text"]'), null, 'no text-layer span injected');
  assert.equal(host.getAttribute('aria-hidden'), null, 'host is NOT aria-hidden');
  assert.equal(r.overlay, null, 'Tier 0 exposes NO overlay (hides nothing)');
  assert.strictEqual(r.element, host, 'element IS the host (the text is the render)');
  assert.notEqual(host.style.display, 'none');
  assert.notEqual(host.style.visibility, 'hidden');
  r.destroy();
});

test('font-stretch is written ONLY in the RENDER phase, clamped to the axis', () => {
  const { doc, host } = makeDoc('A');
  const ticker = manualTicker();
  const controller = { value: 1 };
  const r = createVfRenderer({ host, axis, controller, ticker, document: doc, isReducedMotion: () => false });

  // Spy phases registered BEFORE the renderer's own render callback: during
  // READ/UPDATE the value seen this frame must not yet be written.
  let readSaw = '';
  let updateSaw = '';
  ticker.read(() => { readSaw = host.style.getPropertyValue('font-stretch'); });
  ticker.update(() => { updateSaw = host.style.getPropertyValue('font-stretch'); });

  r.attach(); // paints nothing yet (subscribes; wake only schedules under a real rAF)
  // move the value, then run one deterministic frame
  controller.value = 3.0; // beyond axis → clamps to 125%
  ticker.frame(1);

  assert.equal(readSaw, '', 'font-stretch NOT set during READ');
  assert.equal(updateSaw, '', 'font-stretch NOT set during UPDATE');
  assert.equal(host.style.getPropertyValue('font-stretch'), '125%', 'clamped to axis max in RENDER');

  controller.value = 0.5; // below axis → clamps to 75%
  ticker.frame(2);
  assert.equal(host.style.getPropertyValue('font-stretch'), '75%', 'clamped to axis min');

  controller.value = 1.1;
  ticker.frame(3);
  assert.equal(host.style.getPropertyValue('font-stretch'), '110%', 'in-range value passes through');
  r.destroy();
});

test('font-variation-settings apply mode writes the raw wdth axis value', () => {
  const { doc, host } = makeDoc('A');
  const ticker = manualTicker();
  const controller = { value: 1.2 };
  const r = createVfRenderer({ host, axis, controller, ticker, document: doc, apply: 'font-variation-settings', isReducedMotion: () => false });
  r.attach();
  ticker.frame(1);
  assert.equal(host.style.getPropertyValue('font-variation-settings'), '"wdth" 120');
  assert.equal(host.style.getPropertyValue('font-stretch'), '', 'font-stretch not touched in this mode');
  r.destroy();
});

test('the renderer registers NO activity predicate (StretchController owns liveness)', () => {
  const { doc, host } = makeDoc('A');
  const ticker = manualTicker();
  let activityCount = 0;
  const realOnActivity = ticker.onActivity.bind(ticker);
  (ticker as unknown as { onActivity: unknown }).onActivity = (p: () => boolean) => {
    activityCount++;
    return realOnActivity(p);
  };
  const r = createVfRenderer({ host, axis, controller: { value: 1 }, ticker, document: doc, isReducedMotion: () => false });
  r.attach();
  assert.equal(activityCount, 0, 'Tier 0 must not register its own liveness predicate');
  r.destroy();
});

test('reduced motion: paints resting ONCE and registers NO per-frame render callback', () => {
  const { doc, host } = makeDoc('A');
  const ticker = manualTicker();
  let renders = 0;
  const realRender = ticker.render.bind(ticker);
  (ticker as unknown as { render: unknown }).render = (fn: (n: number) => void) => {
    renders++;
    return realRender(fn);
  };
  const controller = { value: 3.0 };
  const r = createVfRenderer({ host, axis, controller, ticker, document: doc, restingStretch: 1, isReducedMotion: () => true });
  r.attach();

  assert.equal(renders, 0, 'no RENDER subscription under reduced motion');
  assert.equal(host.style.getPropertyValue('font-stretch'), '100%', 'resting width applied once');

  // even if the value changes and a frame runs, nothing repaints (no subscription)
  controller.value = 1.25;
  ticker.frame(1);
  assert.equal(host.style.getPropertyValue('font-stretch'), '100%', 'static — no per-frame update');
  r.destroy();
});

test('wrap:nowrap sets white-space:nowrap on the host', () => {
  const { doc, host } = makeDoc('Long headline');
  const r = createVfRenderer({ host, axis, controller: { value: 1 }, ticker: manualTicker(), document: doc, wrap: 'nowrap', isReducedMotion: () => false });
  r.attach();
  assert.equal(host.style.getPropertyValue('white-space'), 'nowrap');
  r.destroy();
});

test('wrap:reserve reserves max-stretch width from a READ-phase measurement', () => {
  const { doc, host } = makeDoc('WIDE');
  const ticker = manualTicker();
  const NATURAL = 200;
  host.getBoundingClientRect = () => ({ width: NATURAL, height: 40, top: 0, left: 0, right: NATURAL, bottom: 40, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const r = createVfRenderer({ host, axis, controller: { value: 1 }, ticker, document: doc, wrap: 'reserve', restingStretch: 1, isReducedMotion: () => false });
  r.attach();
  // measurement happens in the READ phase
  assert.equal(host.style.getPropertyValue('min-width'), '', 'not reserved before a frame');
  ticker.frame(1);
  // resting % = 100, axis.max = 125 → factor 1.25 → 200 * 1.25 = 250px
  assert.equal(host.style.getPropertyValue('min-width'), '250px', 'reserves widest box the axis can reach');
  r.destroy();
});

test('reserveBasis:tier-capability (default) reserves the axis-bounded box', () => {
  const NATURAL = 200;
  // default (option omitted)
  const a = makeDoc('WIDE');
  a.host.getBoundingClientRect = () => ({ width: NATURAL, height: 40, top: 0, left: 0, right: NATURAL, bottom: 40, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const tickerA = manualTicker();
  const rA = createVfRenderer({ host: a.host, axis, controller: { value: 1 }, ticker: tickerA, document: a.doc, wrap: 'reserve', restingStretch: 1, isReducedMotion: () => false });
  rA.attach();
  tickerA.frame(1);
  // 200 × (125/100) = 250
  assert.equal(a.host.style.getPropertyValue('min-width'), '250px', 'default reserves axis-bounded 250px');
  rA.destroy();

  // explicit 'tier-capability' must match the default byte-for-byte
  const b = makeDoc('WIDE');
  b.host.getBoundingClientRect = () => ({ width: NATURAL, height: 40, top: 0, left: 0, right: NATURAL, bottom: 40, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const tickerB = manualTicker();
  const rB = createVfRenderer({ host: b.host, axis, controller: { value: 1 }, ticker: tickerB, document: b.doc, wrap: 'reserve', reserveBasis: 'tier-capability', restingStretch: 1, isReducedMotion: () => false });
  rB.attach();
  tickerB.frame(1);
  assert.equal(b.host.style.getPropertyValue('min-width'), '250px', 'explicit tier-capability === default');
  rB.destroy();
});

test('reserveBasis:uniform reserves naturalWidth × maxStretchRatio (default 4.5) — a permanent gap past the axis', () => {
  const NATURAL = 200;
  const { doc, host } = makeDoc('WIDE');
  host.getBoundingClientRect = () => ({ width: NATURAL, height: 40, top: 0, left: 0, right: NATURAL, bottom: 40, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const ticker = manualTicker();
  const r = createVfRenderer({ host, axis, controller: { value: 1 }, ticker, document: doc, wrap: 'reserve', reserveBasis: 'uniform', restingStretch: 1, isReducedMotion: () => false });
  r.attach();
  ticker.frame(1);
  // 200 × 4.5 = 900 — NOT the axis-bounded 250, proving the modes diverge
  assert.equal(host.style.getPropertyValue('min-width'), '900px', 'uniform reserves the full max-ratio box');
  r.destroy();
});

test('reserveBasis:uniform honors a custom maxStretchRatio', () => {
  const NATURAL = 200;
  const { doc, host } = makeDoc('WIDE');
  host.getBoundingClientRect = () => ({ width: NATURAL, height: 40, top: 0, left: 0, right: NATURAL, bottom: 40, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const ticker = manualTicker();
  const r = createVfRenderer({ host, axis, controller: { value: 1 }, ticker, document: doc, wrap: 'reserve', reserveBasis: 'uniform', maxStretchRatio: 3, restingStretch: 1, isReducedMotion: () => false });
  r.attach();
  ticker.frame(1);
  // 200 × 3 = 600
  assert.equal(host.style.getPropertyValue('min-width'), '600px', 'uniform uses the supplied max ratio');
  r.destroy();
});

test('reserveBasis: the two modes genuinely differ for VF (250 vs 900)', () => {
  const NATURAL = 200;
  const cap = makeDoc('WIDE');
  cap.host.getBoundingClientRect = () => ({ width: NATURAL, height: 40, top: 0, left: 0, right: NATURAL, bottom: 40, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const tCap = manualTicker();
  const rCap = createVfRenderer({ host: cap.host, axis, controller: { value: 1 }, ticker: tCap, document: cap.doc, wrap: 'reserve', reserveBasis: 'tier-capability', restingStretch: 1, isReducedMotion: () => false });
  rCap.attach();
  tCap.frame(1);

  const uni = makeDoc('WIDE');
  uni.host.getBoundingClientRect = () => ({ width: NATURAL, height: 40, top: 0, left: 0, right: NATURAL, bottom: 40, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const tUni = manualTicker();
  const rUni = createVfRenderer({ host: uni.host, axis, controller: { value: 1 }, ticker: tUni, document: uni.doc, wrap: 'reserve', reserveBasis: 'uniform', restingStretch: 1, isReducedMotion: () => false });
  rUni.attach();
  tUni.frame(1);

  assert.notEqual(
    cap.host.style.getPropertyValue('min-width'),
    uni.host.style.getPropertyValue('min-width'),
    'tier-capability and uniform must reserve different widths for VF',
  );
  assert.equal(cap.host.style.getPropertyValue('min-width'), '250px');
  assert.equal(uni.host.style.getPropertyValue('min-width'), '900px');
  rCap.destroy();
  rUni.destroy();
});

test('destroy() restores the host inline style and stops writing', () => {
  const { doc, host } = makeDoc('A');
  host.setAttribute('style', 'font-weight: 700;');
  const before = host.getAttribute('style');
  const ticker = manualTicker();
  const controller = { value: 1 };
  const r = createVfRenderer({ host, axis, controller, ticker, document: doc, isReducedMotion: () => false });
  r.attach();
  controller.value = 1.2;
  ticker.frame(1);
  assert.equal(host.style.getPropertyValue('font-stretch'), '120%');
  r.destroy();
  assert.equal(host.getAttribute('style'), before, 'original inline style restored exactly');
  // a stray frame after destroy must not repaint
  controller.value = 1.25;
  ticker.frame(2);
  assert.equal(host.style.getPropertyValue('font-stretch'), '', 'no writes after destroy');
});
