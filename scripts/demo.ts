/**
 * scripts/demo.ts — CORE-MATH ILLUSTRATION (not a capture of the shipped renderer).
 *
 * Parses a system font with the FontParser, runs buildFlexField +
 * computeFlexProfile + buildRemap from src/core, and writes side-by-side SVGs:
 *   original | naive scale | tangent-aligned stretch
 * The SVGs are drawn directly from the remapped outlines, so they show what the
 * math produces — NOT what the WebGL/SVG tiers paint in a browser. The vertical
 * variant exercises the y-axis field of the core only: no renderer applies a
 * vertical remap in 0.1.x. The README's demo image (demos/demo-horizontal.png)
 * is a real headless-Chrome capture of the WebGL tier, not this script's output.
 *
 * Run: node scripts/demo.ts [/path/to/font.ttf]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { parseFont } from '../src/font/parser.ts';
import { commandsToContours, evalSegment } from '../src/core/geometry/segments.ts';
import type { Segment } from '../src/core/geometry/segments.ts';
import { sampleOutline, sampleBounds } from '../src/core/sampling/outline.ts';
import { computeFlexProfile, buildFlexField } from '../src/core/flex-profile.ts';
import { buildRemap } from '../src/core/lut.ts';
import type { PathCommand, Axis } from '../src/core/types.ts';

const CANDIDATES = [
  process.argv[2],
  '/System/Library/Fonts/Supplemental/Georgia.ttf',
  '/System/Library/Fonts/NewYork.ttf',
  '/System/Library/Fonts/Supplemental/Times New Roman.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
].filter(Boolean) as string[];

const fontPath = CANDIDATES.find((p) => existsSync(p));
if (!fontPath) {
  console.error('No system font found; pass a .ttf path as argv[2].');
  process.exit(1);
}
const buf = readFileSync(fontPath);
const font = parseFont(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, {
  fontSize: 1000,
});
console.log(`Loaded: ${font.name ?? fontPath}`);

function flatten(
  commands: PathCommand[],
  mapX: (x: number) => number,
  mapY: (y: number) => number,
  steps = 28,
): string {
  const contours = commandsToContours(commands);
  let d = '';
  for (const segs of contours) {
    segs.forEach((seg: Segment, si) => {
      if (si === 0) {
        const p0 = evalSegment(seg, 0);
        d += `M${mapX(p0.x).toFixed(2)},${mapY(p0.y).toFixed(2)}`;
      }
      const pts: string[] = [];
      for (let i = 1; i <= steps; i++) {
        const p = evalSegment(seg, i / steps);
        pts.push(`${mapX(p.x).toFixed(2)},${mapY(p.y).toFixed(2)}`);
      }
      d += 'L' + pts.join('L');
    });
    d += 'Z';
  }
  return d;
}

function analyze(ch: string, axis: Axis, k = 10) {
  const g = font.glyph(ch);
  if (!g) throw new Error(`no glyph for ${ch}`);
  const outline = sampleOutline(g.commands, 24);
  const bb = sampleBounds(outline);
  const bounds = axis === 'x' ? { min: bb.minX, max: bb.maxX } : { min: bb.minY, max: bb.maxY };
  const crossBounds = axis === 'x' ? { min: bb.minY, max: bb.maxY } : { min: bb.minX, max: bb.maxX };
  const field = buildFlexField(outline);
  const flex = computeFlexProfile(outline, {
    axis, slices: 96, k, bounds, crossBounds, interiorSamples: 72, field,
  });
  return { commands: g.commands, bb, bounds, flex };
}

function render(letters: string[], axis: Axis, stretch: number, out: string, k = 10) {
  let cellW = 0, cellH = 0;
  const rows = letters.map((ch) => {
    const g = analyze(ch, axis, k);
    const { remap } = buildRemap(g.flex, { ...g.bounds, stretch });
    const W = g.bb.maxX - g.bb.minX, H = g.bb.maxY - g.bb.minY;
    cellW = Math.max(cellW, axis === 'x' ? W * stretch : W);
    cellH = Math.max(cellH, axis === 'y' ? H * stretch : H);
    const orig = flatten(g.commands, (x) => x, (y) => y);
    const naive = flatten(
      g.commands,
      axis === 'x' ? (x) => g.bb.minX + (x - g.bb.minX) * stretch : (x) => x,
      axis === 'y' ? (y) => g.bb.minY + (y - g.bb.minY) * stretch : (y) => y,
    );
    const ours = flatten(
      g.commands,
      axis === 'x' ? (x) => remap(x) : (x) => x,
      axis === 'y' ? (y) => remap(y) : (y) => y,
    );
    return { ch, orig, naive, ours, bb: g.bb };
  });

  const pad = 60, colGap = cellW + 140, rowGap = cellH + 120;
  const labels = ['original', `naive scale ${stretch}×`, `tangent-aligned ${stretch}×`];
  let body = '';
  rows.forEach((r, ri) => {
    [r.orig, r.naive, r.ours].forEach((d, ci) => {
      const tx = pad + ci * colGap - r.bb.minX;
      const ty = pad + ri * rowGap - r.bb.minY;
      body += `<g transform="translate(${tx},${ty})"><path d="${d}" fill="#111"/></g>\n`;
      if (ri === 0) {
        body += `<text x="${pad + ci * colGap}" y="${pad - 25}" font-family="sans-serif" font-size="34" fill="#666">${labels[ci]}</text>\n`;
      }
    });
  });
  const width = pad * 2 + 2 * colGap + cellW;
  const height = pad * 2 + (rows.length - 1) * rowGap + cellH;
  // Square outer canvas + meet so previews (qlmanage square-crops) show all
  // three columns letterboxed, never cropped.
  const side = 1600;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${side}" height="${side}" preserveAspectRatio="xMidYMid meet"><rect x="0" y="0" width="${width}" height="${height}" fill="#fff"/>\n${body}</svg>`;
  writeFileSync(out, svg);
  console.log(`wrote ${out} (${Math.round(width)}×${Math.round(height)})`);
}

mkdirSync(new URL('../demos/', import.meta.url), { recursive: true });
const dir = new URL('../demos/', import.meta.url).pathname;
render(['R', 'B', 'H'], 'x', 2.5, `${dir}demo-horizontal.svg`);
render(['S', 'E'], 'y', 2.0, `${dir}demo-vertical.svg`);
console.log('done');
