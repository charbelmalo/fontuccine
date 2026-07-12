/**
 * 08-real-font-demo.mjs — end-to-end proof on a REAL font.
 * Parses a .ttf with opentype.js, runs the Fontuccine analysis core
 * (01-flex-profile) + remap (02-lut-remap) on real glyph outlines, and
 * writes side-by-side SVG comparisons: original vs naive scale vs
 * tangent-aligned stretch.
 *
 * Run: npm i opentype.js && node 08-real-font-demo.mjs /path/to/font.ttf
 * (Demo flattens curves to dense polylines for output simplicity; the
 *  production SVG tier keeps true béziers via bezier.js splitting.)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import opentype from 'opentype.js';
import { sampleOutline, computeFlexProfile, sampleBounds, commandsToContours } from './01-flex-profile.mjs';
import { buildRemap } from './02-lut-remap.mjs';

const fontPath = process.argv[2] ?? '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf';
const font = opentype.parse(readFileSync(fontPath).buffer);
console.log(`Loaded: ${font.names.fullName?.en ?? fontPath}`);

/** Flatten a glyph's contours to remapped polyline path data. */
function glyphToPath(commands, mapX = (x) => x, mapY = (y) => y, steps = 28) {
  const contours = commandsToContours(commands);
  let d = '';
  for (const segs of contours) {
    segs.forEach((seg, si) => {
      const pts = [];
      const from = si === 0 ? 1 : 0; // first segment includes start point
      for (let i = 1 - from; i <= steps; i++) {
        const t = i / steps;
        const p = evalSeg(seg, t);
        pts.push(`${mapX(p.x).toFixed(2)},${mapY(p.y).toFixed(2)}`);
      }
      if (si === 0) {
        const p0 = evalSeg(seg, 0);
        d += `M${mapX(p0.x).toFixed(2)},${mapY(p0.y).toFixed(2)}`;
      }
      d += 'L' + pts.join('L');
    });
    d += 'Z';
  }
  return d;
}

function evalSeg(seg, t) {
  const { p0 } = seg, mt = 1 - t;
  if (seg.type === 'L') return { x: p0.x + t * (seg.p1.x - p0.x), y: p0.y + t * (seg.p1.y - p0.y) };
  if (seg.type === 'Q') {
    const { p1, p2 } = seg;
    return {
      x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
      y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
    };
  }
  const { p1, p2, p3 } = seg;
  return {
    x: mt ** 3 * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t ** 3 * p3.x,
    y: mt ** 3 * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t ** 3 * p3.y,
  };
}

function analyzeGlyph(char, axis, k = 10) {
  const glyph = font.charToGlyph(char);
  const commands = glyph.getPath(0, 0, 1000).commands; // 1000upm, y already SVG-down
  const outline = sampleOutline(commands, 32);
  const bb = sampleBounds(outline);
  const bounds = axis === 'x' ? { min: bb.minX, max: bb.maxX } : { min: bb.minY, max: bb.maxY };
  const crossBounds = axis === 'x' ? { min: bb.minY, max: bb.maxY } : { min: bb.minX, max: bb.maxX };
  const flex = computeFlexProfile(outline, {
    axis, slices: 96, k, bounds, crossBounds, interiorSamples: 72, smooth: 0.75,
  });
  return { commands, bb, bounds, flex };
}

function renderComparison({ letters, axis, stretch, out, k = 10 }) {
  const cell = { w: 0, h: 0 };
  const rows = [];
  for (const ch of letters) {
    const g = analyzeGlyph(ch, axis, k);
    const { remap } = buildRemap(g.flex, { ...g.bounds, stretch });
    const W = g.bb.maxX - g.bb.minX, H = g.bb.maxY - g.bb.minY;
    const sw = axis === 'x' ? W * stretch : W;
    const sh = axis === 'y' ? H * stretch : H;
    cell.w = Math.max(cell.w, sw); cell.h = Math.max(cell.h, sh);

    const orig = glyphToPath(g.commands);
    const naive = glyphToPath(
      g.commands,
      axis === 'x' ? (x) => g.bb.minX + (x - g.bb.minX) * stretch : (x) => x,
      axis === 'y' ? (y) => g.bb.minY + (y - g.bb.minY) * stretch : (y) => y,
    );
    const ours = glyphToPath(
      g.commands,
      axis === 'x' ? (x) => remap(x) : (x) => x,
      axis === 'y' ? (y) => remap(y) : (y) => y,
    );
    rows.push({ ch, orig, naive, ours, bb: g.bb });
  }

  const pad = 60, colGap = cell.w + 140, rowGap = cell.h + 120;
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
  const width = pad * 2 + 2 * colGap + cell.w;
  const height = pad * 2 + (rows.length - 1) * rowGap + cell.h;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${Math.round(width / 2)}" height="${Math.round(height / 2)}"><rect width="100%" height="100%" fill="#fff"/>\n${body}</svg>`;
  writeFileSync(out, svg);
  console.log(`wrote ${out} (${Math.round(width)}×${Math.round(height)})`);
}

renderComparison({ letters: ['R', 'B', 'H'], axis: 'x', stretch: 2.5, out: 'demo-horizontal.svg' });
renderComparison({ letters: ['S', 'E'], axis: 'y', stretch: 2.0, out: 'demo-vertical.svg' });
console.log('done');
