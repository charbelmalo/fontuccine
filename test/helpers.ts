/**
 * test/helpers.ts — shared test fixtures + system-font discovery.
 */
import { readFileSync, existsSync } from 'node:fs';
import type { PathCommand } from '../src/core/types.ts';
import { parseFont } from '../src/font/parser.ts';
import type { ParsedFont } from '../src/font/parser.ts';

/** Synthetic 'I': solid vertical bar x∈[0,100], y∈[0,700]. */
export const rect: PathCommand[] = [
  { type: 'M', x: 0, y: 0 },
  { type: 'L', x: 100, y: 0 },
  { type: 'L', x: 100, y: 700 },
  { type: 'L', x: 0, y: 700 },
  { type: 'Z' },
];

/** Synthetic twin stems (an 'H' minus crossbar). */
export const stems: PathCommand[] = [
  { type: 'M', x: 0, y: 0 }, { type: 'L', x: 100, y: 0 },
  { type: 'L', x: 100, y: 700 }, { type: 'L', x: 0, y: 700 }, { type: 'Z' },
  { type: 'M', x: 400, y: 0 }, { type: 'L', x: 500, y: 0 },
  { type: 'L', x: 500, y: 700 }, { type: 'L', x: 400, y: 700 }, { type: 'Z' },
];

const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Georgia.ttf',
  '/System/Library/Fonts/Supplemental/Times New Roman.ttf',
  '/System/Library/Fonts/NewYork.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Geneva.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/Library/Fonts/Arial.ttf',
];

function toArrayBuffer(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Load the first parseable system serif/sans font, or null if none found. */
export function loadSystemFont(): { font: ParsedFont; path: string } | null {
  for (const path of FONT_CANDIDATES) {
    if (!existsSync(path)) continue;
    try {
      const font = parseFont(toArrayBuffer(path), { fontSize: 1000 });
      // sanity: must yield a real glyph for 'R'
      if (font.glyph('R')) return { font, path };
    } catch {
      // try next candidate
    }
  }
  return null;
}
