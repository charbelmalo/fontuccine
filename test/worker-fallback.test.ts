/**
 * worker-fallback.test.ts — main-thread fallback when a Worker is unusable,
 * WOFF2 rejection, and the engine's renderer→SVG fallback.
 *
 * A consumer's bundler may fail to ship the worker script (it 404s / fails to
 * load → the Worker fires `error`). The clients must then serve every pending
 * and future request inline instead of rejecting, and report mode/reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { AnalysisClient } from '../src/worker/client.ts';
import { MsdfClient } from '../src/webgl/msdf/client.ts';
import { loadEngineFont, WOFF2_UNSUPPORTED_MESSAGE } from '../src/engine/font-load.ts';
import { attach } from '../src/engine/attach.ts';
import type { ParsedFont } from '../src/font/parser.ts';
import type { RenderBackend } from '../src/webgl/gl/device.ts';
import { rect } from './helpers.ts';

/** A Worker whose script "failed to load": fires `error` asynchronously, never answers. */
class BrokenWorker {
  onmessage: ((ev: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessageerror: ((e: unknown) => void) | null = null;
  terminated = false;
  constructor() {
    setTimeout(() => this.onerror?.({ type: 'error' }), 0);
  }
  postMessage(): void {}
  terminate(): void {
    this.terminated = true;
  }
}

test('AnalysisClient: worker error → pending + future requests served inline', async () => {
  let w: BrokenWorker | null = null;
  const reasons: string[] = [];
  const client = new AnalysisClient({
    workerFactory: () => (w = new BrokenWorker()) as unknown as Worker,
    onFallback: (r) => reasons.push(r),
  });
  assert.equal(client.mode, 'worker');
  const [a, b] = await Promise.all([
    client.analyze({ glyphId: 'g1', commands: rect, advanceWidth: 140, axes: ['x'] }),
    client.analyze({ glyphId: 'g2', commands: rect, advanceWidth: 140, axes: ['y'] }),
  ]);
  assert.ok(a.profiles.x && b.profiles.y, 'pending requests resolved inline');
  assert.equal(client.mode, 'inline');
  assert.match(client.reason ?? '', /worker error/);
  assert.equal(reasons.length, 1);
  assert.ok(w!.terminated, 'dead worker terminated');
  const c = await client.analyze({ glyphId: 'g3', commands: rect, advanceWidth: 140, axes: ['x'] });
  assert.ok(c.profiles.x, 'future request served inline');
  client.destroy();
});

test('AnalysisClient: spawn throwing → inline with reason; explicit inline has no reason', async () => {
  const client = new AnalysisClient({
    workerFactory: () => {
      throw new Error('blocked by CSP');
    },
  });
  const r = await client.analyze({ glyphId: 'g', commands: rect, advanceWidth: 140, axes: ['x'] });
  assert.ok(r.profiles.x);
  assert.equal(client.mode, 'inline');
  assert.match(client.reason ?? '', /blocked by CSP/);
  const forced = new AnalysisClient({ inline: true });
  assert.equal(forced.mode, 'inline');
  assert.equal(forced.reason, undefined);
});

test('MsdfClient: worker error → pending bitmap generated inline', async () => {
  const client = new MsdfClient({ workerFactory: () => new BrokenWorker() as unknown as Worker });
  const bmp = await client.generate({
    glyphId: 'r',
    commands: rect,
    options: { fontSize: 24, pxRange: 4, unitsPerEm: 1000, bbox: { minX: 0, minY: 0, maxX: 100, maxY: 700 } },
  });
  assert.ok(bmp.width > 0 && bmp.height > 0 && bmp.data.length === bmp.width * bmp.height * 4);
  assert.equal(client.mode, 'inline');
  assert.match(client.reason ?? '', /worker error/);
  client.destroy();
});

test('WOFF2 is rejected up front with an actionable message', async () => {
  const woff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0, 0, 0, 0, 0]).buffer;
  await assert.rejects(loadEngineFont({ fontBuffer: woff2 }), (err: Error) => {
    assert.equal(err.name, 'FontUnavailableError');
    assert.equal(err.message, WOFF2_UNSUPPORTED_MESSAGE);
    return true;
  });
});

test('fontUrl answered with HTML (dev-server 404 → 200 index.html) names the wrong path', async () => {
  const realFetch = globalThis.fetch;
  const html = new TextEncoder().encode('<!doctype html><html><body>app</body></html>');
  const expected = 'fontuccine: fontUrl did not return a font (got HTML — wrong path?) for /fonts/missing.ttf';
  try {
    // content-type: text/html
    globalThis.fetch = (async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })) as typeof fetch;
    await assert.rejects(loadEngineFont({ fontUrl: '/fonts/missing.ttf' }), { message: expected });
    // mislabelled type, but the body starts with '<'
    globalThis.fetch = (async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'application/octet-stream' } })) as typeof fetch;
    await assert.rejects(loadEngineFont({ fontUrl: '/fonts/missing.ttf' }), { message: expected });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('attach: WebGL renderer without a usable backend falls back to SVG and reports it', async () => {
  const dom = new JSDOM('<!doctype html><body><h1 id="hero">AB</h1></body>');
  const win = dom.window as unknown as { ResizeObserver: unknown };
  win.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = win.ResizeObserver;
  const doc = dom.window.document;
  const host = doc.querySelector('#hero') as HTMLElement;
  const font: ParsedFont = {
    unitsPerEm: 1000,
    glyph: (ch) =>
      /\s/.test(ch) ? null : { commands: rect, advanceWidth: 140, bbox: { minX: 0, minY: 0, maxX: 100, maxY: 700 } },
    kernPair: () => 0,
  };
  const inst = attach(host, {
    parsedFont: font,
    tier: 'webgl',
    trigger: 'custom',
    document: doc,
    detectWebGL2Support: () => true,
    isReducedMotion: () => false,
    isPrint: () => false,
    backend: { supported: false } as unknown as RenderBackend,
  });
  await inst.ready;
  assert.equal(inst.tier, 'svg', 'tier reports what actually renders');
  assert.match(inst.notes.join(' | '), /webgl renderer failed .* falling back to SVG/);
  assert.ok(host.querySelector('svg[data-fontuccine="svg-tier"]'), 'svg layer mounted');
  assert.ok(!inst.notes.some((n) => n.startsWith('build failed')));
  inst.destroy();
});
