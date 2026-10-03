import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { WebGL2Backend } from '../src/webgl/gl/device.ts';
import {
  setBackendFactory,
  acquireSharedBackend,
  releaseSharedBackend,
  __resetSharedBackend,
} from '../src/webgl/gl/shared.ts';

/**
 * webgl-shared-release.test.ts — releasing the LAST shared-backend reference
 * must give the browser its context back (WEBGL_lose_context) and remove the
 * hidden scratch canvas, or every rebuild leaks one canvas + one live context.
 */

/** A permissive fake WebGL2 context: every method returns a truthy object. */
function fakeGl(withLoseContext: boolean) {
  const calls = { loseContext: 0 };
  const ext = { loseContext: () => { calls.loseContext++; } };
  const gl = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, prop) {
      if (prop === 'getExtension') {
        return withLoseContext ? (name: string) => (name === 'WEBGL_lose_context' ? ext : null) : undefined;
      }
      if (prop === 'isContextLost') return () => false;
      if (prop === 'then') return undefined;
      return () => ({});
    },
  });
  return { gl, calls };
}

function setup(withLoseContext: boolean) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;
  const { gl, calls } = fakeGl(withLoseContext);
  let canvas: HTMLCanvasElement | null = null;
  setBackendFactory((slices) => {
    canvas = doc.createElement('canvas');
    (canvas as unknown as { getContext: () => unknown }).getContext = () => gl;
    doc.body.appendChild(canvas);
    const b = new WebGL2Backend(canvas, slices);
    return b.supported ? b : null;
  });
  return { doc, calls, canvas: () => canvas };
}

test('releasing the last shared reference loses the context and removes the canvas', () => {
  __resetSharedBackend();
  const { doc, calls, canvas } = setup(true);
  const a = acquireSharedBackend();
  const b = acquireSharedBackend();
  assert.ok(a && a === b, 'one shared backend');
  assert.ok(canvas()?.isConnected, 'canvas attached while in use');

  releaseSharedBackend();
  assert.equal(calls.loseContext, 0, 'not released while a reference remains');
  assert.ok(canvas()?.isConnected, 'canvas kept while a reference remains');

  releaseSharedBackend();
  assert.equal(calls.loseContext, 1, 'WEBGL_lose_context.loseContext() called once');
  assert.equal(canvas()?.isConnected, false, 'hidden canvas removed from the DOM');
  assert.equal(doc.querySelectorAll('canvas').length, 0);

  setBackendFactory(null);
  __resetSharedBackend();
});

test('destroy tolerates a context without WEBGL_lose_context (still removes the canvas)', () => {
  __resetSharedBackend();
  const { calls, canvas } = setup(false);
  assert.ok(acquireSharedBackend());
  assert.doesNotThrow(() => releaseSharedBackend());
  assert.equal(calls.loseContext, 0);
  assert.equal(canvas()?.isConnected, false, 'canvas removed even without the extension');

  setBackendFactory(null);
  __resetSharedBackend();
});
