/**
 * webgl-lut-texture.test.ts — packing the per-glyph cumulative-flex LUTs into
 * ONE R32F texture (row per glyph) and reading them back exactly (obligation:
 * "zero rebinds mid-draw" — one texture for a whole run). Also proves every
 * packed row still satisfies the frozen FlexLUT contract (assertLUT).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packLUTAtlas, unpackLUTRow, lutRowCoord } from '../src/webgl/lut-texture.ts';
import { buildFlexCumulative } from '../src/webgl/parity.ts';
import { assertLUT } from '../src/core/lut.ts';

function fakeFlex(n: number, seed: number): Float32Array {
  const f = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    f[i] = (s % 1000) / 1000; // non-negative flex weights
  }
  return f;
}

test('pack → unpack is bit-exact for every glyph row', () => {
  const luts = [buildFlexCumulative(fakeFlex(96, 1)), buildFlexCumulative(fakeFlex(96, 7)), buildFlexCumulative(fakeFlex(96, 99))];
  const atlas = packLUTAtlas(luts);
  assert.equal(atlas.width, 97); // N+1
  assert.equal(atlas.height, 3);
  assert.equal(atlas.data.length, 97 * 3);
  for (let g = 0; g < luts.length; g++) {
    const row = unpackLUTRow(atlas, g);
    assert.deepEqual(Array.from(row), Array.from(luts[g]), `row ${g} round-trip`);
  }
});

test('every packed row satisfies the FlexLUT contract', () => {
  const luts = Array.from({ length: 5 }, (_, i) => buildFlexCumulative(fakeFlex(64, i + 1)));
  const atlas = packLUTAtlas(luts);
  for (let g = 0; g < luts.length; g++) {
    assertLUT(unpackLUTRow(atlas, g)); // throws on violation
  }
});

test('fully-rigid glyph (ΣF≈0) degrades to the uniform ramp and still packs', () => {
  const rigid = buildFlexCumulative(new Float32Array(48)); // all zeros
  assert.equal(rigid[0], 0);
  assert.equal(rigid[rigid.length - 1], 1);
  assertLUT(rigid);
  const atlas = packLUTAtlas([rigid]);
  const back = unpackLUTRow(atlas, 0);
  // uniform ramp i/N
  for (let i = 0; i < back.length; i++) {
    assert.ok(Math.abs(back[i] - i / 48) < 1e-6, `uniform ramp @${i}`);
  }
});

test('non-uniform slice counts are rejected (grid must be uniform)', () => {
  const a = buildFlexCumulative(fakeFlex(96, 1));
  const b = buildFlexCumulative(fakeFlex(64, 2));
  assert.throws(() => packLUTAtlas([a, b]), /slice count must be uniform/);
});

test('empty input yields an empty atlas; row coord is the texel center', () => {
  const empty = packLUTAtlas([]);
  assert.equal(empty.width, 0);
  assert.equal(empty.height, 0);
  assert.ok(Math.abs(lutRowCoord(0, 4) - 0.125) < 1e-9);
  assert.ok(Math.abs(lutRowCoord(3, 4) - 0.875) < 1e-9);
});
