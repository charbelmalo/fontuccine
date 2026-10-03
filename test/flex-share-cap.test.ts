/**
 * flex-share-cap.test.ts — the per-slice share cap (capFlexShares).
 *
 * Diagonal-only glyphs ("w", "v", "A") have flex ≈ 1 only in the 1–3 apex
 * slices, so proportional distribution dumped the whole extra width there
 * (one slice ×30–50 at stretch 2.5). The cap bounds any slice's growth at
 * 1 + (stretch − 1)·maxShareFactor while leaving profiles that already respect
 * it untouched, and — because it lives in the flex profile itself — the CPU
 * remap (buildRemap) and the GPU mirror (buildFlexCumulative) stay identical.
 *
 * Probe: `FLEX_PROBE=1 node --test test/flex-share-cap.test.ts` prints the
 * before/after max-growth table on the playground font for factors 3..6.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sampleOutline, sampleBounds } from '../src/core/sampling/outline.ts';
import { computeFlexProfile, buildFlexField, capFlexShares } from '../src/core/flex-profile.ts';
import { buildRemap } from '../src/core/lut.ts';
import { DEFAULT_PARAMS } from '../src/core/types.ts';
import { buildFlexCumulative, gpuRemapX } from '../src/webgl/parity.ts';
import { parseFont } from '../src/font/parser.ts';
import type { ParsedFont } from '../src/font/parser.ts';

const FONT_PATH = fileURLToPath(
  new URL('../playground/public/fonts/RobotoFlex-VF.ttf', import.meta.url),
);

function loadFont(): ParsedFont | null {
  if (!existsSync(FONT_PATH)) return null;
  const buf = readFileSync(FONT_PATH);
  return parseFont(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, {
    fontSize: 2048,
  });
}

function shares(flex: Float32Array): number[] {
  let sum = 0;
  for (const f of flex) sum += f;
  return Array.from(flex, (f) => f / sum);
}

function sum(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

/** Real-font x-axis profile with the library defaults, cap factor overridable. */
function analyzeX(font: ParsedFont, ch: string, maxShareFactor: number) {
  const g = font.glyph(ch);
  if (!g) throw new Error(`no glyph for ${ch}`);
  const outline = sampleOutline(g.commands, DEFAULT_PARAMS.samplesPerSegment);
  const bb = sampleBounds(outline);
  const bounds = { min: bb.minX, max: bb.maxX };
  const flex = computeFlexProfile(outline, {
    axis: 'x',
    slices: DEFAULT_PARAMS.slices,
    k: DEFAULT_PARAMS.k,
    interiorSamples: DEFAULT_PARAMS.interiorSamples,
    smooth: DEFAULT_PARAMS.smooth,
    bounds,
    crossBounds: { min: bb.minY, max: bb.maxY },
    field: buildFlexField(outline),
    maxShareFactor,
  });
  return { flex, bounds };
}

/** Per-slice growth factor g_i = (w + e_i)/w through the real buildRemap. */
function growth(flex: Float32Array, bounds: { min: number; max: number }, stretch: number): number[] {
  const r = buildRemap(flex, { ...bounds, stretch });
  return Array.from(r.extras, (e) => (r.sliceWidth + e) / r.sliceWidth);
}

/** Perpendicular weight ratio of a stroke at `deg` from horizontal under x-scale g. */
function weightRatio(g: number, deg: number): number {
  const t = (deg * Math.PI) / 180;
  return g / Math.sqrt(g * g * Math.cos(t) ** 2 + Math.sin(t) ** 2);
}

// ── synthetic ────────────────────────────────────────────────────────────────

test('cap enforced and Σ preserved on a spiky (diagonal-like) profile', () => {
  const N = 96;
  const flex = new Float32Array(N).fill(0.004); // |cos45°|^8 ≈ 0.004
  flex[20] = flex[48] = flex[76] = 1; // three apexes
  flex[47] = flex[49] = 0.3;
  for (const factor of [1, 2, 3, 4, 6]) {
    const out = capFlexShares(flex, factor);
    const s = shares(out);
    for (let i = 0; i < N; i++) {
      assert.ok(Number.isFinite(out[i]) && out[i] >= 0, `finite/non-negative @${i}`);
      assert.ok(out[i] <= 1 + 1e-6, `value ≤ 1 @${i}`);
      assert.ok(s[i] <= factor / N + 1e-6, `factor ${factor}: share[${i}]=${s[i]} > ${factor / N}`);
    }
    assert.ok(Math.abs(sum(out) - sum(flex)) < 1e-4, `Σ preserved (factor ${factor})`);
    const cum = buildFlexCumulative(out);
    for (let i = 1; i < cum.length; i++) assert.ok(cum[i] >= cum[i - 1], 'monotonic cumulative');
  }
  // factor 1 (and anything < 1) is the uniform distribution
  const u = shares(capFlexShares(flex, 0.5));
  for (const v of u) assert.ok(Math.abs(v - 1 / N) < 1e-6);
});

test('fully rigid slices absorb overflow evenly (floor)', () => {
  const flex = new Float32Array(10); // all exactly 0 …
  flex[5] = 1; // … except one apex
  const s = shares(capFlexShares(flex, 4));
  assert.ok(Math.abs(s[5] - 0.4) < 1e-6, `apex share capped at 4/10 (got ${s[5]})`);
  for (let i = 0; i < 10; i++) if (i !== 5) assert.ok(Math.abs(s[i] - 0.6 / 9) < 1e-6);
});

test('an H-like profile that already respects the cap is returned unchanged', () => {
  // stems rigid, ~40% crossbar/counter region free: shares ≈ 1/38 < 4/96
  const N = 96;
  const flex = new Float32Array(N);
  for (let i = 0; i < N; i++) flex[i] = i < 18 || i >= 78 ? 0.001 : i < 29 || i >= 67 ? 0.02 : 1;
  const out = capFlexShares(flex, 4);
  assert.notEqual(out, flex, 'returns a new array');
  assert.deepEqual(Array.from(out), Array.from(flex));
});

test('Infinity / non-positive factor disables the cap; rigid Σ≈0 passes through', () => {
  const flex = new Float32Array([0, 0, 1, 0, 0]);
  assert.deepEqual(Array.from(capFlexShares(flex, Infinity)), Array.from(flex));
  assert.deepEqual(Array.from(capFlexShares(flex, 0)), Array.from(flex));
  const rigid = new Float32Array(8);
  assert.deepEqual(Array.from(capFlexShares(rigid, 4)), Array.from(rigid));
});

// ── real font ────────────────────────────────────────────────────────────────

test('real "w" at 2.5×: max slice growth ≤ 7 on CPU remap AND identical on GPU mirror', (t) => {
  const font = loadFont();
  if (!font) return t.skip('playground font missing');
  const stretch = 2.5;
  const raw = analyzeX(font, 'w', Infinity);
  const capped = analyzeX(font, 'w', 4);
  const rawMax = Math.max(...growth(raw.flex, raw.bounds, stretch));
  const gCap = growth(capped.flex, capped.bounds, stretch);
  const capMax = Math.max(...gCap);
  assert.ok(rawMax > 10, `defect reproduces uncapped (max growth ${rawMax.toFixed(2)})`);
  assert.ok(capMax <= 7.01, `capped max growth ${capMax.toFixed(3)} ≤ 7`);

  // Default options apply the cap (DEFAULT_PARAMS.maxShareFactor = 4).
  const g = font.glyph('w')!;
  const outline = sampleOutline(g.commands, 24);
  const bb = sampleBounds(outline);
  const def = computeFlexProfile(outline, {
    axis: 'x', slices: 96, k: 8, bounds: { min: bb.minX, max: bb.maxX },
    crossBounds: { min: bb.minY, max: bb.maxY },
  });
  assert.equal(DEFAULT_PARAMS.maxShareFactor, 4);
  assert.ok(Math.max(...growth(def, { min: bb.minX, max: bb.maxX }, stretch)) <= 7.01);

  // Parity: GPU mirror (cumulative share LUT) == core remap on the capped profile.
  const { min, max } = capped.bounds;
  const r = buildRemap(capped.flex, { min, max, stretch });
  const cum = buildFlexCumulative(capped.flex);
  let dev = 0;
  for (let j = 0; j <= 1000; j++) {
    const x = min + ((max - min) * j) / 1000;
    dev = Math.max(dev, Math.abs(gpuRemapX(cum, x, min, max, min, stretch) - r.remap(x)));
  }
  assert.ok(dev < 1e-3, `GPU/CPU remap deviation ${dev} font units`);
});

test('probe table (FLEX_PROBE=1 prints it)', (t) => {
  const font = loadFont();
  if (!font) return t.skip('playground font missing');
  const glyphs = ['w', 'y', 'H', 't', 'o', 'e'];
  const factors = [Infinity, 3, 4, 5, 6];
  const rows: string[] = [];
  const pad = (s: string, n: number) => s.padStart(n);
  rows.push(`max per-slice growth g = 1 + N·(stretch−1)·share   (N=${DEFAULT_PARAMS.slices})`);
  rows.push(`${pad('glyph', 5)} ${pad('stretch', 7)} ${factors.map((f) => pad(f === Infinity ? 'uncapped' : `cap ${f}`, 9)).join(' ')}`);
  for (const ch of glyphs) {
    const profs = factors.map((f) => analyzeX(font, ch, f));
    for (const stretch of [1.5, 2, 2.5]) {
      const cells = profs.map((p) => pad(Math.max(...growth(p.flex, p.bounds, stretch)).toFixed(2), 9));
      rows.push(`${pad(ch, 5)} ${pad(stretch.toFixed(1), 7)} ${cells.join(' ')}`);
    }
  }
  // 'w' diagonals: slices that are rigid in the RAW profile (flex < 0.05).
  const raw = analyzeX(font, 'w', Infinity);
  const rigid = Array.from(raw.flex, (f, i) => (f < 0.05 ? i : -1)).filter((i) => i >= 0);
  rows.push('');
  rows.push(`"w" diagonal slices (raw flex < 0.05: ${rigid.length}/${raw.flex.length}) at stretch 2.5:`);
  rows.push(`${pad('factor', 9)} ${pad('max g', 7)} ${pad('mean g', 7)} ${pad('wt45 max', 9)} ${pad('wt45 mean', 9)} ${pad('wt70 mean', 9)}`);
  for (const f of factors) {
    const p = analyzeX(font, 'w', f);
    const g = growth(p.flex, p.bounds, 2.5);
    const gd = rigid.map((i) => g[i]);
    const gMax = Math.max(...gd);
    const gMean = sum(gd) / gd.length;
    rows.push(
      `${pad(f === Infinity ? 'uncapped' : String(f), 9)} ${pad(gMax.toFixed(3), 7)} ${pad(gMean.toFixed(3), 7)} ` +
        `${pad(`${((weightRatio(gMax, 45) - 1) * 100).toFixed(1)}%`, 9)} ${pad(`${((weightRatio(gMean, 45) - 1) * 100).toFixed(1)}%`, 9)} ` +
        `${pad(`${((weightRatio(gMean, 70) - 1) * 100).toFixed(1)}%`, 9)}`,
    );
  }
  // The four 'w' strokes ≈ the four quarters of the slice range; per stroke,
  // min/max growth over its rigid (raw flex < 0.05), non-capped slices.
  rows.push('');
  rows.push('"w" per-stroke growth at stretch 2.5 (quarters, rigid non-capped slices):');
  const N = raw.flex.length;
  for (const f of factors) {
    const p = analyzeX(font, 'w', f);
    const g = growth(p.flex, p.bounds, 2.5);
    const capG = 1 + 1.5 * f;
    const cells: string[] = [];
    for (let q = 0; q < 4; q++) {
      const gs: number[] = [];
      for (let i = Math.round((q * N) / 4); i < Math.round(((q + 1) * N) / 4); i++) {
        if (raw.flex[i] < 0.05 && g[i] < capG - 1e-3) gs.push(g[i]);
      }
      cells.push(`${Math.min(...gs).toFixed(2)}–${Math.max(...gs).toFixed(2)}`);
    }
    rows.push(`${pad(f === Infinity ? 'uncapped' : String(f), 9)} ${cells.map((c) => pad(c, 11)).join(' ')}`);
  }
  if (process.env.FLEX_PROBE) console.log('\n' + rows.join('\n'));
  assert.ok(rows.length > 0);
});
