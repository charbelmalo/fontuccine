/**
 * Variable-font instancing (gvar/avar) — verified against fontTools
 * `varLib.instancer` ground truth (test/fixtures/robotoflex-instances.json:
 * Roboto Flex instanced at four locations, incl. two composite glyphs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseFont } from '../src/font/parser.ts';
import type { ParsedGlyph } from '../src/font/parser.ts';
import { createInstancer, readVariationTables, normalizeCoords, unpackWoff, isWoff } from '../src/font/variation.ts';

const VF = new URL('../playground/public/fonts/RobotoFlex-VF.ttf', import.meta.url);
const STATIC = new URL('./fixtures/RobotoFlex-static-subset.ttf', import.meta.url);
const WOFF = new URL('./fixtures/RobotoFlex-VF-subset.woff', import.meta.url);
const TRUTH = new URL('./fixtures/robotoflex-instances.json', import.meta.url);

interface TruthGlyph { glyph: string; points: [number, number][]; ends: number[]; onCurve: number[]; advance: number; composite: boolean }
interface Truth {
  axes: [string, number, number, number][];
  unitsPerEm: number;
  chars: Record<string, TruthGlyph>;
  locations: Record<string, { loc: Record<string, number>; chars: Record<string, TruthGlyph> }>;
}

async function load(url: URL): Promise<ArrayBuffer> {
  const b = await readFile(url);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}
const truthP = readFile(TRUTH, 'utf8').then((s) => JSON.parse(s) as Truth);

/** Points the path emits that MUST coincide with real outline points: every
 *  quadratic control (off-curve) and every line endpoint (on-curve). Implied
 *  midpoints between two off-curve points are skipped. */
function anchorPoints(g: ParsedGlyph): [number, number][] {
  const out: [number, number][] = [];
  for (const c of g.commands) {
    if (c.type === 'Q') out.push([c.x1!, -c.y1!]);
    if (c.type === 'L') out.push([c.x!, -c.y!]);
  }
  return out;
}
function maxNearest(pts: [number, number][], truth: [number, number][]): number {
  let worst = 0;
  for (const [x, y] of pts) {
    let best = Infinity;
    for (const [tx, ty] of truth) best = Math.min(best, Math.max(Math.abs(x - tx), Math.abs(y - ty)));
    worst = Math.max(worst, best);
  }
  return worst;
}

test('readVariationTables: Roboto Flex exposes 13 axes, gvar + avar, glyf outlines; static font → null', async () => {
  const t = readVariationTables(await load(VF));
  assert.ok(t);
  assert.equal(t!.axes.length, 13);
  assert.deepEqual(t!.axes.find((a) => a.tag === 'wght'), { tag: 'wght', min: 100, default: 400, max: 1000 });
  assert.ok(t!.gvar && t!.gvar.glyphCount === 269);
  assert.ok(t!.avar && t!.avar.length === 13);
  assert.equal(t!.outlines, 'glyf');
  assert.equal(readVariationTables(await load(STATIC)), null);
});

test('normalizeCoords: clamps, maps through avar, default → all zeros', async () => {
  const t = readVariationTables(await load(VF))!;
  const zero = normalizeCoords(t, {});
  assert.ok(Array.from(zero).every((v) => v === 0));
  const c = normalizeCoords(t, { wght: 1000, wdth: 25, opsz: 9999 });
  const i = (tag: string) => t.axes.findIndex((a) => a.tag === tag);
  assert.equal(c[i('wght')], 1);
  assert.equal(c[i('wdth')], -1);
  assert.equal(c[i('opsz')], 1); // clamped to max 144
  const mid = normalizeCoords(t, { wght: 700 });
  assert.ok(mid[i('wght')]! > 0 && mid[i('wght')]! < 1);
});

test('gvar deltas reproduce fontTools instancing for every simple glyph at 4 locations (≤ 1 unit, advance ≤ 1)', async () => {
  const buf = await load(VF);
  const truth = await truthP;
  const ot = (await import('opentype.js')).default;
  const font = ot.parse(buf);
  let checked = 0;
  for (const [name, loc] of Object.entries(truth.locations)) {
    const r = createInstancer(buf, loc.loc);
    assert.ok(r.ok, name);
    if (!r.ok) continue;
    for (const [ch, tg] of Object.entries(loc.chars)) {
      if (tg.composite || tg.points.length === 0) continue;
      const def = truth.chars[ch]!;
      const pts = def.points.map(([x, y]) => ({ x, y }));
      const d = r.instancer.deltas(font.charToGlyph(ch).index, pts, def.ends);
      assert.ok(d, `${name} ${ch} has deltas`);
      let worst = 0;
      for (let i = 0; i < pts.length; i++) {
        worst = Math.max(worst, Math.abs(pts[i]!.x + d!.dx[i]! - tg.points[i]![0]), Math.abs(pts[i]!.y + d!.dy[i]! - tg.points[i]![1]));
      }
      assert.ok(worst <= 1, `${name} ${ch}: worst point error ${worst}`);
      const n = pts.length;
      const adv = def.advance + d!.dx[n + 1]! - d!.dx[n]!;
      assert.ok(Math.abs(adv - tg.advance) <= 1, `${name} ${ch}: advance ${adv} vs ${tg.advance}`);
      checked++;
    }
  }
  assert.ok(checked >= 40);
});

test('parser: a requested wght=700 is honoured — bold outline differs from Regular and matches the fontTools bold instance', async () => {
  const buf = await load(VF);
  const truth = await truthP;
  const upm = truth.unitsPerEm;
  const regular = parseFont(buf, { fontSize: upm });
  const bold = parseFont(buf, { fontSize: upm, variations: { wght: 700 } });
  assert.equal(bold.variation?.applied, true);
  assert.equal(bold.variation?.location?.wght, 700);
  const S0 = regular.glyph('S')!;
  const S1 = bold.glyph('S')!;
  assert.notDeepEqual(S1.commands, S0.commands, 'bold outline must differ from regular');
  assert.ok(S1.advanceWidth > S0.advanceWidth, 'bold S is wider');
  // vertical stem of the "t" gets thicker: measure the ink span of the stem on the default vs bold
  for (const [ch, tg] of Object.entries(truth.locations.bold!.chars)) {
    if (tg.points.length === 0) continue;
    const g = bold.glyph(ch)!;
    const err = maxNearest(anchorPoints(g), tg.points);
    assert.ok(err <= 1, `bold ${ch}${tg.composite ? ' (composite)' : ''}: anchor point error ${err}`);
    assert.ok(Math.abs(g.advanceWidth - tg.advance) <= 1, `bold ${ch} advance ${g.advanceWidth} vs ${tg.advance}`);
  }
  // opsz + wght together (what a 128px bold heading resolves to) and the extremes
  for (const name of ['bold-opsz128', 'thin-narrow', 'wide-grad'] as const) {
    const loc = truth.locations[name]!;
    const p = parseFont(buf, { fontSize: upm, variations: loc.loc });
    for (const [ch, tg] of Object.entries(loc.chars)) {
      if (tg.points.length === 0) continue;
      const g = p.glyph(ch)!;
      assert.ok(maxNearest(anchorPoints(g), tg.points) <= 1, `${name} ${ch}`);
      assert.ok(Math.abs(g.advanceWidth - tg.advance) <= 1, `${name} ${ch} advance`);
    }
  }
});

test('parser: blank-glyph advances follow the instance (space advance = fontTools value at every location)', async () => {
  const buf = await load(VF);
  const truth = await truthP;
  const def = parseFont(buf, { fontSize: truth.unitsPerEm });
  assert.equal(def.glyph(' '), null, 'space has no ink');
  assert.equal(def.advance!(' '), truth.chars[' ']!.advance);
  let changed = 0;
  for (const [name, loc] of Object.entries(truth.locations)) {
    const p = parseFont(buf, { fontSize: truth.unitsPerEm, variations: loc.loc });
    assert.equal(p.glyph(' '), null);
    const adv = p.advance!(' ');
    assert.ok(Math.abs(adv - loc.chars[' ']!.advance) <= 1, `${name}: space advance ${adv} vs ${loc.chars[' ']!.advance}`);
    if (adv !== def.advance!(' ')) changed++;
  }
  assert.ok(changed >= 1, 'at least one location moves the space advance');
});

test('parser: requests at the default location or out of range are clamped / reported', async () => {
  const buf = await load(VF);
  const def = parseFont(buf, { fontSize: 1000 });
  const same = parseFont(buf, { fontSize: 1000, variations: { wght: 400, opsz: 14 } });
  assert.equal(same.variation?.applied, false);
  assert.equal(same.variation?.reason, 'default-location');
  assert.deepEqual(same.glyph('R')!.commands, def.glyph('R')!.commands);
  const clamped = parseFont(buf, { fontSize: 1000, variations: { wght: 5000 } });
  assert.equal(clamped.variation?.location?.wght, 1000);
  const ignored = parseFont(buf, { fontSize: 1000, variations: { ZZZZ: 3 } });
  assert.equal(ignored.variation?.applied, false);
});

test('parser: a static (non-variable) font still works and ignores the request', async () => {
  const buf = await load(STATIC);
  const plain = parseFont(buf, { fontSize: 1000 });
  const asked = parseFont(buf, { fontSize: 1000, variations: { wght: 700, wdth: 150 } });
  assert.equal(asked.variation?.applied, false);
  assert.equal(asked.variation?.reason, 'not-variable');
  for (const ch of 'Stretchy') {
    assert.deepEqual(asked.glyph(ch)!.commands, plain.glyph(ch)!.commands, ch);
    assert.equal(asked.glyph(ch)!.advanceWidth, plain.glyph(ch)!.advanceWidth);
  }
  assert.equal(asked.advance!(' '), plain.advance!(' '));
});

test('WOFF 1: unpackWoff repacks compressed tables so instancing works on a .woff variable font', async () => {
  const woff = await load(WOFF);
  assert.ok(isWoff(woff));
  const sfnt = await unpackWoff(woff);
  assert.ok(!isWoff(sfnt));
  const truth = await truthP;
  const bold = parseFont(sfnt, { fontSize: truth.unitsPerEm, variations: { wght: 700 } });
  assert.equal(bold.variation?.applied, true);
  const tg = truth.locations.bold!.chars.S!;
  assert.ok(maxNearest(anchorPoints(bold.glyph('S')!), tg.points) <= 1);
  assert.ok(Math.abs(bold.glyph('S')!.advanceWidth - tg.advance) <= 1);
});
