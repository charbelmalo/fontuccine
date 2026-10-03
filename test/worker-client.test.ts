/**
 * worker-client.test.ts — worker protocol (T7) + client cache/fallback.
 *
 *  - analyzeGlyph (pure) returns the AnalyzeResponse shape.
 *  - AnalysisClient inline fallback works with no Worker (SSR/tests).
 *  - AnalysisClient with an injected (mock) Worker resolves by id and caches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGlyph, collectTransferables } from '../src/worker/analyze.ts';
import { AnalysisClient } from '../src/worker/client.ts';
import type { AnalyzeRequest, AnalyzeResponse } from '../src/core/types.ts';
import { DEFAULT_PARAMS } from '../src/core/types.ts';
import { rect } from './helpers.ts';

function req(id = 1): AnalyzeRequest {
  return {
    id,
    glyphId: 'rect',
    commands: rect,
    axes: ['x', 'y'],
    params: DEFAULT_PARAMS,
    advanceWidth: 140,
  };
}

test('analyzeGlyph returns the AnalyzeResponse shape', () => {
  const res = analyzeGlyph(req());
  assert.equal(res.id, 1);
  assert.equal(res.glyphId, 'rect');
  assert.equal(res.advanceWidth, 140);
  assert.ok(res.bbox.maxX > res.bbox.minX && res.bbox.maxY > res.bbox.minY);
  assert.ok(res.profiles.x?.flex instanceof Float32Array);
  assert.ok(res.profiles.y?.flex instanceof Float32Array);
  assert.equal(res.profiles.x?.flex.length, DEFAULT_PARAMS.slices);
  // x also carries the straight-column profile (core/straight-profile.ts)
  assert.ok(res.profiles.x?.straight instanceof Float32Array);
  assert.equal(res.profiles.x?.straight?.length, DEFAULT_PARAMS.slices);
  // transferables are the flex buffers + the x straight profile
  assert.equal(collectTransferables(res).length, 3);
});

test('AnalysisClient inline fallback resolves and caches', async () => {
  const client = new AnalysisClient(); // no Worker in Node → inline
  const r1 = await client.analyze({ glyphId: 'rect', commands: rect, advanceWidth: 140, axes: ['x'] });
  assert.ok(r1.profiles.x?.flex instanceof Float32Array);
  assert.equal(client.cacheCount, 1);

  const r2 = await client.analyze({ glyphId: 'rect', commands: rect, advanceWidth: 140, axes: ['x'] });
  assert.equal(r2, r1, 'second identical request served from cache');
  assert.equal(client.cacheCount, 1);

  // different axis set → distinct cache entry
  await client.analyze({ glyphId: 'rect', commands: rect, advanceWidth: 140, axes: ['x', 'y'] });
  assert.equal(client.cacheCount, 2);
  client.destroy();
});

test('AnalysisClient drives an injected worker by id + transfers', async () => {
  // Mock Worker that runs analyzeGlyph off the postMessage path.
  const posted: ArrayBuffer[][] = [];
  class MockWorker {
    onmessage: ((ev: { data: AnalyzeResponse }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    postMessage(request: AnalyzeRequest): void {
      queueMicrotask(() => {
        const res = analyzeGlyph(request);
        posted.push(collectTransferables(res));
        this.onmessage?.({ data: res });
      });
    }
    terminate(): void {}
  }
  const client = new AnalysisClient({ workerFactory: () => new MockWorker() as unknown as Worker });

  const [a, b] = await Promise.all([
    client.analyze({ glyphId: 'g1', commands: rect, advanceWidth: 140, axes: ['x'] }),
    client.analyze({ glyphId: 'g2', commands: rect, advanceWidth: 140, axes: ['y'] }),
  ]);
  assert.equal(a.glyphId, 'g1');
  assert.equal(b.glyphId, 'g2');
  assert.ok(a.profiles.x && b.profiles.y);
  assert.equal(posted.length, 2, 'two messages transferred flex buffers');
  assert.equal(client.cacheCount, 2);
  client.destroy();
});
