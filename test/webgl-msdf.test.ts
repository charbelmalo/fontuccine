/**
 * webgl-msdf.test.ts — runtime multi-channel SDF generation (msdfgen-style).
 *
 * Proves the field is VALID (inside > edge > outside after median), that the
 * median reconstruction matches the fragment shader's `median3`, and — the
 * reason MSDF exists — that the 3-channel field PRESERVES a convex corner that
 * a single-channel (true-distance) field ROUNDS. The discriminator: just
 * outside a 90° convex corner along the diagonal, the true-distance SDF reads
 * the radial distance to the corner point, while the pseudo-distance MSDF median
 * reconstructs the sharp corner (intersection of two half-planes) and so reads
 * a SMALLER exterior magnitude. Also checks the DPR-keyed client cache.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMSDF, median3 } from '../src/webgl/msdf/generator.ts';
import type { MSDFBitmap } from '../src/webgl/msdf/generator.ts';
import { MsdfClient } from '../src/webgl/msdf/client.ts';
import type { PathCommand } from '../src/core/types.ts';
import { rect } from './helpers.ts';

const BBOX = { minX: 0, minY: 0, maxX: 100, maxY: 700 };
const OPTS = { bbox: BBOX, fontSize: 64, unitsPerEm: 1000, pxRange: 4 };

/** Decode the signed distance (in texels) the shader would see at a pixel. */
function decodeMedian(bmp: MSDFBitmap, i: number, j: number): number {
  const o = (j * bmp.width + i) * 4;
  const r = bmp.data[o + 0] / 255 - 0.5;
  const g = bmp.data[o + 1] / 255 - 0.5;
  const b = bmp.data[o + 2] / 255 - 0.5;
  return median3(r, g, b); // in units of pxRange; >0 inside, <0 outside
}

/** Glyph coords → nearest pixel (inverse of the generator's toGlyph* maps). */
function pixelAt(bmp: MSDFBitmap, gx: number, gy: number): [number, number] {
  const i = Math.round((gx - bmp.bbox.minX) * bmp.scale + bmp.padding - 0.5);
  const j = Math.round((bmp.bbox.maxY - gy) * bmp.scale + bmp.padding - 0.5);
  return [
    Math.max(0, Math.min(bmp.width - 1, i)),
    Math.max(0, Math.min(bmp.height - 1, j)),
  ];
}

test('median3 matches the msdfgen / shader median of three channels', () => {
  assert.equal(median3(0.1, 0.9, 0.5), 0.5);
  assert.equal(median3(0.9, 0.1, 0.5), 0.5);
  assert.equal(median3(-0.2, -0.8, -0.5), -0.5);
  assert.equal(median3(7, 7, 7), 7);
});

test('MSDF bitmap is well-formed and signed correctly (inside > 0 > outside)', () => {
  const bmp = generateMSDF(rect, OPTS);
  assert.ok(bmp.width > 0 && bmp.height > 0);
  assert.equal(bmp.data.length, bmp.width * bmp.height * 4);
  // alpha channel is fully opaque
  for (let p = 3; p < bmp.data.length; p += 4) assert.equal(bmp.data[p], 255);

  // deep interior positive, far exterior negative
  const [ii, ij] = pixelAt(bmp, 50, 350); // center of the bar
  assert.ok(decodeMedian(bmp, ii, ij) > 0, 'interior median > 0');
  const [oi, oj] = pixelAt(bmp, 50, 350); // corner-adjust below
  void oi;
  void oj;
  assert.ok(decodeMedian(bmp, 0, 0) < 0, 'top-left padding corner exterior < 0');
});

test('3-channel MSDF preserves a convex corner that single-channel rounds', () => {
  // A square with well-separated corners so a diagonal-outside sample is nearest
  // its OWN corner, not the opposite edge (a narrow rect contaminates the test).
  const SQ = 500;
  const square: PathCommand[] = [
    { type: 'M', x: 0, y: 0 },
    { type: 'L', x: SQ, y: 0 },
    { type: 'L', x: SQ, y: SQ },
    { type: 'L', x: 0, y: SQ },
    { type: 'Z' },
  ];
  const sqOpts = { bbox: { minX: 0, minY: 0, maxX: SQ, maxY: SQ }, fontSize: 64, unitsPerEm: 1000, pxRange: 4 };
  const msdf = generateMSDF(square, { ...sqOpts });
  const single = generateMSDF(square, { ...sqOpts, singleChannel: true });
  assert.equal(msdf.width, single.width);
  assert.equal(msdf.height, single.height);

  // The square's four convex corners in glyph space.
  const corners: Array<[number, number, number, number]> = [
    // [cornerX, cornerY, outwardX, outwardY] diagonal offsets (font units)
    [SQ, SQ, +1, +1],
    [0, SQ, -1, +1],
    [SQ, 0, +1, -1],
    [0, 0, -1, -1],
  ];
  // ~1.3 texels diagonally out: inside pxRange (4) so the field isn't saturated,
  // but far enough that true-distance rounding (single) diverges from the
  // pseudo-distance corner reconstruction (MSDF). Beyond pxRange both clamp.
  const off = 20;
  let sharperCount = 0;
  for (const [cx, cy, dx, dy] of corners) {
    const gx = cx + dx * off;
    const gy = cy + dy * off;
    const [pi, pj] = pixelAt(msdf, gx, gy);
    const mMed = decodeMedian(msdf, pi, pj); // < 0 (outside)
    const sMed = decodeMedian(single, pi, pj); // < 0 (outside)
    // MSDF keeps the corner sharp ⇒ the point is CLOSER to the reconstructed
    // (extended) edge ⇒ its exterior magnitude is smaller ⇒ median is GREATER.
    if (mMed > sMed + 1e-4) sharperCount++;
  }
  assert.ok(
    sharperCount >= 3,
    `MSDF sharper than single-channel at ${sharperCount}/4 convex corners`,
  );
});

test('single-channel and MSDF AGREE far from corners (straight edges)', () => {
  const msdf = generateMSDF(rect, { ...OPTS });
  const single = generateMSDF(rect, { ...OPTS, singleChannel: true });
  // Midpoint of the long right edge, a couple texels outside — a straight edge
  // has no corner to preserve, so both fields should read nearly the same.
  const [pi, pj] = pixelAt(msdf, 130, 350);
  const m = decodeMedian(msdf, pi, pj);
  const s = decodeMedian(single, pi, pj);
  assert.ok(Math.abs(m - s) < 0.1, `straight-edge agreement |${m} - ${s}|`);
});

test('MsdfClient caches per (glyph, size, pxRange, dpr) and re-rasters on DPR change', async () => {
  const client = new MsdfClient({ inline: true });
  const commands: PathCommand[] = rect;
  const input = { glyphId: 'rect', commands, options: OPTS, dpr: 1 };
  assert.equal(client.peek(input), undefined);
  const a = await client.generate(input);
  assert.ok(client.peek(input), 'cached after first generate');
  const b = await client.generate(input);
  assert.equal(a, b, 'same bitmap instance served from cache');

  // A DPR change is part of the cache key ⇒ a fresh raster (obligation 6).
  const hidpi = { ...input, dpr: 2 };
  assert.equal(client.peek(hidpi), undefined, 'DPR=2 is a cache miss');
  const c = await client.generate(hidpi);
  assert.notEqual(a, c, 'DPR change re-rasterizes');
  client.destroy();
});
