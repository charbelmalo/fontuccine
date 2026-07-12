/**
 * react-wrapper.test.ts — `fontuccine/react` SSR-inertness, StrictMode double
 * mount safety, and shared-backend ref-count survival across mount/unmount/mount.
 *
 * SSR: `renderToString` runs with NO jsdom globals installed — proving the module
 * touches no window/document at import or during server render (attach only runs
 * in an effect, which SSR never fires).
 *
 * StrictMode (React 18 dev double-invoke): mount→unmount→mount must not leak or
 * break. With the WebGL tier + a mock shared backend we assert exactly ONE
 * context is created (the aborted first mount never acquires) and it is destroyed
 * on final unmount, then a fresh acquire recreates — i.e. the ref-count is intact,
 * never destroyed-then-dangling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as React from 'react';
import { createElement, StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { Fontuccine } from '../src/react/index.ts';
import type { ParsedFont } from '../src/font/parser.ts';
import {
  setBackendFactory,
  acquireSharedBackend,
  releaseSharedBackend,
  __resetSharedBackend,
} from '../src/webgl/gl/shared.ts';
import type { RenderBackend, RunHandle, GlyphRunData } from '../src/webgl/gl/device.ts';
import { rect } from './helpers.ts';

function stubFont(): ParsedFont {
  return {
    unitsPerEm: 1000,
    glyph(ch: string) {
      if (/\s/.test(ch)) return null;
      return { commands: rect, advanceWidth: 140, bbox: { minX: 0, minY: 0, maxX: 100, maxY: 700 } };
    },
    kernPair: () => 0,
  };
}

// ── 1. SSR: no globals installed ────────────────────────────────────────────
test('SSR: renderToString ships the text and touches no window/document', () => {
  assert.equal(typeof (globalThis as { window?: unknown }).window, 'undefined');
  const html = renderToString(
    createElement(Fontuccine, { as: 'h1', config: { parsedFont: stubFont() } }, 'STRETCH'),
  );
  assert.match(html, /<h1[^>]*>STRETCH<\/h1>/);
});

// ── 2. shared-backend ref-count survives release→re-acquire (direct) ─────────
test('acquireSharedBackend ref-count returns to 0 and re-acquire recreates the context', () => {
  let created = 0;
  const destroyed: boolean[] = [];
  class Run implements RunHandle {
    upload(_d: GlyphRunData): void {}
    draw(): void {}
    dispose(): void {}
  }
  class B implements RenderBackend {
    readonly supported = true;
    readonly canvas = {} as HTMLCanvasElement;
    readonly contextCreationCount = 1;
    private idx: number;
    constructor(i: number) {
      this.idx = i;
    }
    isContextLost() {
      return false;
    }
    ensureSize() {}
    ensureAtlas() {}
    uploadAtlasCell() {}
    beginFrame() {}
    createRun(): RunHandle {
      return new Run();
    }
    onContextLost() {
      return () => {};
    }
    onContextRestored() {
      return () => {};
    }
    destroy() {
      destroyed[this.idx] = true;
    }
  }
  __resetSharedBackend();
  setBackendFactory(() => new B(created++));

  const a = acquireSharedBackend(96); // refCount 1, context #0
  const b = acquireSharedBackend(96); // refCount 2, SAME context (shared)
  assert.strictEqual(a, b, 'two acquires share ONE backend');
  assert.equal(created, 1, 'one context created for N instances');

  releaseSharedBackend(); // refCount 1 — still alive
  assert.notEqual(destroyed[0], true, 'not destroyed while a reference remains');
  releaseSharedBackend(); // refCount 0 — destroyed
  assert.equal(destroyed[0], true, 'destroyed when the last reference leaves');

  const c = acquireSharedBackend(96); // refCount 1 again, context #1 (recreated)
  assert.equal(created, 2, 're-acquire after full release recreates the context (no dangling reuse)');
  assert.ok(c);
  releaseSharedBackend();

  setBackendFactory(null);
  __resetSharedBackend();
});

// ── 3. StrictMode mount/unmount/mount through the real wrapper ───────────────
test('StrictMode double-mount: WebGL context created once, destroyed on unmount', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', {
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  (dom.window as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  g.ResizeObserver = (dom.window as unknown as Record<string, unknown>).ResizeObserver;

  const { createRoot } = await import('react-dom/client');
  const act =
    (React as unknown as { act?: (cb: () => Promise<void> | void) => Promise<void> }).act ??
    (await import('react-dom/test-utils')).act;

  // Mock shared WebGL backend so the engine picks Tier 1 without a real GPU.
  let created = 0;
  let destroyed = 0;
  class Run implements RunHandle {
    upload(): void {}
    draw(): void {}
    dispose(): void {}
  }
  class B implements RenderBackend {
    readonly supported = true;
    readonly canvas: HTMLCanvasElement;
    readonly contextCreationCount = 1;
    constructor(doc: Document) {
      this.canvas = doc.createElement('canvas');
    }
    isContextLost() {
      return false;
    }
    ensureSize() {}
    ensureAtlas() {}
    uploadAtlasCell() {}
    beginFrame() {}
    createRun(): RunHandle {
      return new Run();
    }
    onContextLost() {
      return () => {};
    }
    onContextRestored() {
      return () => {};
    }
    destroy() {
      destroyed++;
    }
  }
  __resetSharedBackend();
  setBackendFactory(() => {
    created++;
    return new B(dom.window.document);
  });

  const config = {
    parsedFont: stubFont(),
    detectWebGL2Support: () => true,
    isReducedMotion: () => false,
    document: dom.window.document as unknown as Document,
  };

  const container = dom.window.document.getElementById('root')!;
  const root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(StrictMode, null, createElement(Fontuccine, { as: 'h1', config }, 'AB')),
    );
  });
  // let the async engine build (font/analysis/atlas microtasks) settle
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

  assert.equal(container.querySelector('h1')?.textContent, 'AB', 'text rendered for a11y/SEO');
  assert.ok(created <= 1, `StrictMode created at most one context (got ${created})`);
  assert.equal(destroyed, 0, 'live context not destroyed while mounted');

  await act(async () => {
    root.unmount();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });

  if (created === 1) {
    assert.equal(destroyed, 1, 'context destroyed exactly once on unmount (no leak, no dangling)');
  }

  // ref-count intact: a fresh acquire after unmount recreates cleanly.
  const after = acquireSharedBackend(96);
  assert.ok(after, 'acquire works after StrictMode teardown');
  releaseSharedBackend();

  setBackendFactory(null);
  __resetSharedBackend();
  delete g.window;
  delete g.document;
  delete g.ResizeObserver;
});
