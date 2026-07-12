/**
 * webgl-slice-grid.test.ts — the shared subdivided-quad geometry every glyph is
 * instanced over. Verifies vertex/index counts, that columns march x:0→1 with
 * y∈{0,1}, indices stay in range, and every triangle is wound consistently
 * (CCW in the y-up box) so nothing is back-face culled. Slice count MUST equal
 * the LUT breakpoint count so remap bends land exactly on vertices.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSliceGrid } from '../src/webgl/slice-grid.ts';

test('vertex + index counts match (slices+1)*2 and slices*6', () => {
  for (const slices of [1, 4, 48, 96]) {
    const g = buildSliceGrid(slices);
    assert.equal(g.columns, slices + 1);
    assert.equal(g.vertexCount, (slices + 1) * 2);
    assert.equal(g.boxCoords.length, (slices + 1) * 2 * 2);
    assert.equal(g.indices.length, slices * 6);
    assert.equal(g.slices, slices);
  }
});

test('columns march x: 0→1 strictly, y ∈ {0,1}, endpoints exact', () => {
  const slices = 96;
  const g = buildSliceGrid(slices);
  let prevX = -1;
  for (let c = 0; c < g.columns; c++) {
    const bx = g.boxCoords[(c * 2 + 0) * 2 + 0];
    const by = g.boxCoords[(c * 2 + 0) * 2 + 1];
    const tx = g.boxCoords[(c * 2 + 1) * 2 + 0];
    const ty = g.boxCoords[(c * 2 + 1) * 2 + 1];
    assert.equal(bx, tx, `column ${c} bottom/top share x`);
    assert.equal(by, 0, `bottom y=0`);
    assert.equal(ty, 1, `top y=1`);
    assert.ok(bx > prevX, `x strictly increasing at column ${c}`);
    prevX = bx;
  }
  assert.equal(g.boxCoords[0], 0, 'first x exactly 0');
  assert.equal(g.boxCoords[(g.columns - 1) * 2 * 2], 1, 'last x exactly 1');
});

test('all indices are in range and every triangle is wound CCW', () => {
  const slices = 32;
  const g = buildSliceGrid(slices);
  const vx = (i: number) => g.boxCoords[i * 2 + 0];
  const vy = (i: number) => g.boxCoords[i * 2 + 1];
  for (let t = 0; t < g.indices.length; t += 3) {
    const a = g.indices[t];
    const b = g.indices[t + 1];
    const c = g.indices[t + 2];
    for (const idx of [a, b, c]) {
      assert.ok(idx >= 0 && idx < g.vertexCount, `index ${idx} in range`);
    }
    // signed area (shoelace); CCW in a y-up frame ⇒ positive.
    const area =
      (vx(b) - vx(a)) * (vy(c) - vy(a)) - (vx(c) - vx(a)) * (vy(b) - vy(a));
    assert.ok(area > 0, `triangle ${t / 3} CCW (area ${area})`);
  }
});

test('degenerate slice counts throw', () => {
  assert.throws(() => buildSliceGrid(0), /positive integer/);
  assert.throws(() => buildSliceGrid(-4), /positive integer/);
  assert.throws(() => buildSliceGrid(2.5), /positive integer/);
});
