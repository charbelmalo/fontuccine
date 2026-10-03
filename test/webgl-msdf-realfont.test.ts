/**
 * webgl-msdf-realfont.test.ts — the MSDF field must reproduce REAL glyphs.
 *
 * Renders each glyph's field the way the fragment shader does (bilinear sample
 * of the RGB texels, median, threshold at 0.5) at 2.5× magnification and
 * compares every sample against the exact nonzero-winding inside test. Torn
 * junctions ('t' stem/bar, 'R' leg — overlapping contours in Roboto Flex) and
 * sub-texel slivers show up as mismatches away from the outline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateMSDF, median3 } from '../src/webgl/msdf/generator.ts';
import { parseFont } from '../src/font/parser.ts';
import { commandsToContours, evalSegment } from '../src/core/geometry/segments.ts';
import { windingNumber } from '../src/core/winding.ts';
import type { PathCommand } from '../src/core/types.ts';

const FONT = new URL('../playground/public/fonts/RobotoFlex-VF.ttf', import.meta.url);
const buf = readFileSync(FONT);
const font = parseFont(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { fontSize: 2048 });

function rings(commands: PathCommand[]) {
  return commandsToContours(commands).map((segs) => {
    const ring: [number, number][] = [];
    for (const s of segs) {
      const n = s.type === 'L' ? 1 : 16;
      for (let k = 0; k < n; k++) { const p = evalSegment(s, k / n); ring.push([p.x, p.y]); }
    }
    return ring;
  });
}

/** Shader-equivalent reconstruction: bilinear RGB → median → >0.5. */
function sampleInside(bmp: ReturnType<typeof generateMSDF>, gx: number, gy: number): boolean {
  const fx = (gx - bmp.originX) * bmp.scale - 0.5;
  const fy = (bmp.originY - gy) * bmp.scale - 0.5;
  const i0 = Math.max(0, Math.min(bmp.width - 2, Math.floor(fx)));
  const j0 = Math.max(0, Math.min(bmp.height - 2, Math.floor(fy)));
  const tx = Math.max(0, Math.min(1, fx - i0));
  const ty = Math.max(0, Math.min(1, fy - j0));
  const ch = (i: number, j: number, c: number) => bmp.data[(j * bmp.width + i) * 4 + c] / 255;
  const v = [0, 1, 2].map((c) => {
    const a = ch(i0, j0, c) * (1 - tx) + ch(i0 + 1, j0, c) * tx;
    const b = ch(i0, j0 + 1, c) * (1 - tx) + ch(i0 + 1, j0 + 1, c) * tx;
    return a * (1 - ty) + b * ty;
  });
  return median3(v[0], v[1], v[2]) > 0.5;
}

export function auditGlyph(ch: string, fontSize = 64, pxRange = 8, mag = 2.5) {
  const g = font.glyph(ch)!;
  const t0 = performance.now();
  const bmp = generateMSDF(g.commands, { bbox: g.bbox, fontSize, unitsPerEm: 2048, pxRange });
  const ms = performance.now() - t0;
  const rs = rings(g.commands);
  const step = 1 / (bmp.scale * mag); // one screen pixel at mag× in glyph units
  const texel = 1 / bmp.scale;
  let samples = 0, mismatches = 0, farMismatches = 0;
  // exact distance is expensive; classify "far" mismatches by checking that all
  // 8 neighbours at one texel distance agree with the exact inside test.
  const inside = (x: number, y: number) => windingNumber(x, y, rs) !== 0;
  for (let gy = bmp.originY; gy > bmp.originY - bmp.height * texel; gy -= step) {
    for (let gx = bmp.originX; gx < bmp.originX + bmp.width * texel; gx += step) {
      samples++;
      const ex = inside(gx, gy);
      if (sampleInside(bmp, gx, gy) !== ex) {
        mismatches++;
        // more than ~0.6 texel from any outline change → a real artifact
        let uniform = true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          if (inside(gx + dx * 0.6 * texel, gy + dy * 0.6 * texel) !== ex) { uniform = false; break; }
        }
        if (uniform) farMismatches++;
      }
    }
  }
  return { ch, ms: Math.round(ms), width: bmp.width, height: bmp.height, corrected: bmp.corrected, samples, mismatches, farMismatches };
}

const GLYPHS = ['t', 'e', 'R', 'B', 'H', 'S', 'w', 'y', 'n', 'i'];

test('real-font MSDF reconstructs Roboto Flex glyphs at 2.5x with no interior tears', () => {
  const rows = GLYPHS.map((c) => auditGlyph(c));
  if (process.env.MSDF_PROBE) for (const r of rows) process.stderr.write(JSON.stringify(r) + "\n");
  for (const r of rows) {
    assert.equal(r.farMismatches, 0, `${r.ch}: ${r.farMismatches} torn samples away from the outline`);
    assert.ok(r.mismatches / r.samples < 0.01, `${r.ch}: ${r.mismatches}/${r.samples} edge mismatches`);
    assert.ok(r.ms < 4000, `${r.ch}: generation took ${r.ms} ms`);
  }
});
