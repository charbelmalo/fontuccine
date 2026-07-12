/**
 * svg-renderer.test.ts — Tier-2 renderer discipline (CLAUDE.md rules 4, 6, 7)
 * under jsdom + an injected deterministic ticker.
 *
 * Verifies: one <path> per glyph reused across frames; `d` written ONLY in the
 * RENDER phase (never READ/UPDATE); the settled-frame write is skipped; reduced
 * motion draws ONCE and registers NO per-frame render callback; the headline
 * budget warns; destroy() unsubscribes and restores the DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTicker } from '../src/interaction/ticker.ts';
import type { FrameScheduler } from '../src/interaction/ticker.ts';
import { createSvgRenderer } from '../src/svg/renderer.ts';
import type { SvgGlyph } from '../src/svg/renderer.ts';
import { sampleOutline, sampleBounds } from '../src/core/sampling/outline.ts';
import { computeFlexProfile } from '../src/core/flex-profile.ts';
import type { PathCommand } from '../src/core/types.ts';
import { rect } from './helpers.ts';

/** A ticker whose loop never self-schedules — `frame(now)` is driven by hand. */
function manualTicker() {
  const scheduler: FrameScheduler = { requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 };
  return createTicker(scheduler);
}

function glyphFrom(commands: PathCommand[], char: string, slices = 48): SvgGlyph {
  const outline = sampleOutline(commands, 24);
  const bb = sampleBounds(outline);
  const bounds = { min: bb.minX, max: bb.maxX };
  const flex = computeFlexProfile(outline, {
    axis: 'x',
    slices,
    k: 8,
    bounds,
    crossBounds: { min: bb.minY, max: bb.maxY },
    interiorSamples: 32,
  });
  return { char, commands, flex, bounds, advanceWidth: bb.maxX + 40, bbox: bb };
}

function makeDoc(text = 'STRETCH') {
  const dom = new JSDOM(`<!doctype html><body><h1 id="hero">${text}</h1></body>`);
  const doc = dom.window.document;
  // jsdom lacks ResizeObserver; provide a no-op so attach() is exercised fully.
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

test('one <path> per glyph, created once and reused across frames', () => {
  const { doc, host } = makeDoc('AB');
  const ticker = manualTicker();
  const controller = { value: 1 };
  const glyphs = [glyphFrom(rect, 'A'), glyphFrom(rect, 'B')];
  const r = createSvgRenderer({ host, glyphs, controller, ticker, document: doc, isReducedMotion: () => false });
  r.attach();

  const paths = () => r.element.querySelectorAll('path');
  assert.equal(paths().length, 2, 'two paths');
  const before = Array.from(paths());

  controller.value = 2.5;
  ticker.frame(1);
  controller.value = 3.1;
  ticker.frame(2);

  const after = Array.from(paths());
  assert.equal(after.length, 2, 'still two paths (node tree not rebuilt)');
  assert.strictEqual(after[0], before[0], 'same <path> node reused');
  assert.strictEqual(after[1], before[1]);
  r.destroy();
});

test('`d` is written ONLY in the RENDER phase', () => {
  const { doc, host } = makeDoc('A');
  const ticker = manualTicker();
  const controller = { value: 2 };
  const glyphs = [glyphFrom(rect, 'A')];
  const r = createSvgRenderer({ host, glyphs, controller, ticker, document: doc, isReducedMotion: () => false });

  // Spy phases registered BEFORE the renderer's own: during READ/UPDATE the
  // path must still be undrawn for this (settled→then→changed) frame.
  const seen: string[] = [];
  ticker.read(() => seen.push(`read:d=${r.element.querySelector('path')!.getAttribute('d') ?? 'null'}`));
  ticker.update(() => seen.push(`update:d=${r.element.querySelector('path')!.getAttribute('d') ?? 'null'}`));

  r.attach(); // subscribes read + render (render runs AFTER the spies)
  const path = r.element.querySelector('path')!;
  assert.equal(path.getAttribute('d'), null, 'nothing drawn before the first frame');

  ticker.frame(1);
  assert.equal(seen[0], 'read:d=null', 'no d during READ');
  assert.equal(seen[1], 'update:d=null', 'no d during UPDATE');
  assert.ok(path.getAttribute('d')!.length > 0, 'd present after RENDER');
  r.destroy();
});

test('settled frame is skipped (no redundant write)', () => {
  const { doc, host } = makeDoc('A');
  const ticker = manualTicker();
  const controller = { value: 2 };
  const r = createSvgRenderer({
    host,
    glyphs: [glyphFrom(rect, 'A')],
    controller,
    ticker,
    document: doc,
    isReducedMotion: () => false,
  });
  r.attach();
  ticker.frame(1);
  const path = r.element.querySelector('path')!;
  let writes = 0;
  const original = path.setAttribute.bind(path);
  path.setAttribute = (n: string, v: string) => {
    if (n === 'd') writes++;
    return original(n, v);
  };
  ticker.frame(2); // value unchanged → skip
  assert.equal(writes, 0, 'no write when stretch is unchanged');
  controller.value = 3;
  ticker.frame(3); // value changed → one write
  assert.equal(writes, 1, 'one write when stretch changes');
  r.destroy();
});

test('reduced motion: draws ONCE at rest, NO per-frame render callback', () => {
  const { doc, host } = makeDoc('A');
  const ticker = manualTicker();
  const controller = { value: 3 }; // would-be animated value ignored under RM
  const r = createSvgRenderer({
    host,
    glyphs: [glyphFrom(rect, 'A')],
    controller,
    ticker,
    document: doc,
    respectReducedMotion: true,
    isReducedMotion: () => true,
    restingStretch: 1,
  });
  r.attach();
  const path = r.element.querySelector('path')!;
  const drawn = path.getAttribute('d');
  assert.ok(drawn && drawn.length > 0, 'painted once at attach');

  // No render callback should have been registered → driving frames changes nothing.
  let writes = 0;
  const original = path.setAttribute.bind(path);
  path.setAttribute = (n: string, v: string) => {
    if (n === 'd') writes++;
    return original(n, v);
  };
  controller.value = 4;
  ticker.frame(1);
  ticker.frame(2);
  assert.equal(writes, 0, 'no per-frame writes under reduced motion');
  r.destroy();
});

test('headline budget warns beyond the cap', () => {
  const { doc, host } = makeDoc('x');
  const ticker = manualTicker();
  const glyphs = Array.from({ length: 5 }, (_, i) => glyphFrom(rect, `g${i}`));
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (msg?: unknown) => warnings.push(String(msg));
  try {
    const r = createSvgRenderer({
      host,
      glyphs,
      controller: { value: 1 },
      ticker,
      document: doc,
      isReducedMotion: () => false,
      glyphBudget: 3,
    });
    r.attach();
    r.destroy();
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /exceeds the headline budget/);
});

test('destroy() unsubscribes from the ticker and restores the DOM', () => {
  const { doc, host } = makeDoc('A');
  const ticker = manualTicker();
  const controller = { value: 1 };
  const r = createSvgRenderer({
    host,
    glyphs: [glyphFrom(rect, 'A')],
    controller,
    ticker,
    document: doc,
    isReducedMotion: () => false,
  });
  r.attach();
  ticker.frame(1);
  r.destroy();
  assert.equal(host.textContent, 'A', 'original text restored');
  assert.equal(host.querySelector('svg'), null, 'render layer removed');

  // After destroy, frames must not touch the (removed) nodes / re-subscribe.
  controller.value = 9;
  assert.doesNotThrow(() => {
    ticker.frame(2);
    ticker.frame(3);
  });
});
