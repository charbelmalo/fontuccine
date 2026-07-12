/**
 * webgl-atlas.test.ts — the shared MSDF atlas slot bookkeeping (RESEARCH §5.4:
 * bounded GPU memory on mobile). Pure LRU allocation/eviction + UV math, no GL.
 * Verifies: stable slot per key, isNew semantics (upload exactly once), LRU
 * victim selection under pressure, dirty-queue draining, cellOrigin layout,
 * and clear() (used on DPR change / context loss for lazy re-raster).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MsdfAtlas } from '../src/webgl/msdf/atlas.ts';

test('acquire assigns a stable slot; re-acquire is not new and touches LRU', () => {
  const a = new MsdfAtlas({ size: 256, cellSize: 64 }); // 4×4 = 16 slots
  const e1 = a.acquire('A', 40, 50);
  assert.equal(e1.isNew, true);
  assert.equal(a.count, 1);
  const again = a.acquire('A', 40, 50);
  assert.equal(again.isNew, false);
  assert.equal(again.slot, e1.slot);
  assert.equal(a.count, 1);
});

test('UV rect maps the raster sub-region inside the cell', () => {
  const a = new MsdfAtlas({ size: 1024, cellSize: 64 });
  const e = a.acquire('X', 32, 48);
  const { x, y } = a.cellOrigin(e.slot);
  assert.ok(Math.abs(e.u0 - x / 1024) < 1e-9);
  assert.ok(Math.abs(e.v0 - y / 1024) < 1e-9);
  assert.ok(Math.abs(e.u1 - (x + 32) / 1024) < 1e-9);
  assert.ok(Math.abs(e.v1 - (y + 48) / 1024) < 1e-9);
});

test('cellOrigin walks row-major across the grid', () => {
  const a = new MsdfAtlas({ size: 256, cellSize: 64 }); // cols = 4
  assert.deepEqual(a.cellOrigin(0), { x: 0, y: 0 });
  assert.deepEqual(a.cellOrigin(3), { x: 192, y: 0 });
  assert.deepEqual(a.cellOrigin(4), { x: 0, y: 64 });
  assert.deepEqual(a.cellOrigin(5), { x: 64, y: 64 });
});

test('LRU evicts the least-recently-used key when full', () => {
  const a = new MsdfAtlas({ size: 128, cellSize: 64 }); // 2×2 = 4 slots
  assert.equal(a.capacity, 4);
  for (const k of ['A', 'B', 'C', 'D']) a.acquire(k, 40, 40);
  assert.equal(a.count, 4);

  // Touch A, B, C so D is the LRU victim.
  a.acquire('A', 40, 40);
  a.acquire('B', 40, 40);
  a.acquire('C', 40, 40);

  const eviction = a.acquire('E', 40, 40); // must evict D
  assert.equal(eviction.isNew, true);
  assert.equal(a.has('D'), false, 'D evicted (LRU)');
  assert.equal(a.has('E'), true);
  assert.ok(['A', 'B', 'C'].every((k) => a.has(k)), 'recently-used survive');
  assert.equal(a.count, 4);
});

test('dirty queue holds one entry per (re)assignment and drains', () => {
  const a = new MsdfAtlas({ size: 128, cellSize: 64 });
  a.acquire('A', 10, 10);
  a.acquire('B', 10, 10);
  a.acquire('A', 10, 10); // cached → no new dirty
  const dirty = a.takeDirty();
  assert.equal(dirty.length, 2);
  assert.deepEqual(dirty.map((d) => d.key).sort(), ['A', 'B']);
  assert.equal(a.takeDirty().length, 0, 'drained');
});

test('clear() frees all slots (DPR change / context-loss re-raster path)', () => {
  const a = new MsdfAtlas({ size: 128, cellSize: 64 });
  for (const k of ['A', 'B', 'C']) a.acquire(k, 20, 20);
  a.clear();
  assert.equal(a.count, 0);
  assert.equal(a.takeDirty().length, 0);
  const e = a.acquire('A', 20, 20); // must be treated as brand new
  assert.equal(e.isNew, true);
});
