/**
 * width-plan.test.ts — stretched letters keep their designed shape.
 *
 * The owner's rejection (2026-10-03): at 1.5–2.5× the 'y' was "severely
 * distorted". Root cause: the old model widened every glyph by an x-only
 * column remap, which thickens any steep stroke by g / sqrt(g²cos²θ + sin²θ)
 * and, with unequal column growth, bends straight diagonals into dog-legs.
 * The width plan (core/width-plan.ts + engine/width-ladder.ts) widens with
 * the font's own wdth/XTRA instances and then only stretches horizontal-safe
 * columns and inter-glyph tracking.
 *
 * Metrics, measured on the CPU outline each tier draws (SVG = exact vectors;
 * the WebGL tier places the same geometry, see test/webgl-parity.test.ts):
 *
 *  - DIAGONAL THICKNESS CHANGE. For the two outer strokes of y, v, w, x, scan
 *    horizontal lines through the upper arm band (15–40 % down from the top of
 *    the x-height), fit straight lines to the stroke's left and right edges and
 *    take the perpendicular thickness t = h / sqrt(1 + m²) (h = horizontal run
 *    width, m = dx/dy of the centreline). Ratio t(2.5×) / t(1×).
 *      threshold: 0.85 ≤ ratio ≤ 1.10 — never more than 10 % heavier (the
 *      visible defect was weight gain). The lower bound leaves room for the
 *      type designer: Roboto Flex's own widest instance (wdth 151, XTRA 603)
 *      draws these diagonals 3–13 % LIGHTER than the resting instance.
 *      Measured (wght 700, opsz 120, run "Ayvwkx"): new ×0.870–×0.971;
 *      old model ×1.457 ('x' left) to ×2.400 ('y' left).
 *  - EDGE STRAIGHTNESS. Max residual of those edge points from their fitted
 *    line, as a fraction of the stroke thickness.
 *      threshold: ≤ 0.04. Measured new: 0.000 on every stroke; old 'y' left
 *      arm 0.052 inside this band (its dog-leg kink sits mostly lower).
 *  - SHAPE DEVIATION. Max distance of every outline point from the font's
 *    widest designed instance of that glyph (after aligning the pen).
 *      threshold: ≤ 1 font unit — a diagonal-only glyph at 2.5× IS the
 *      designer's widest drawing; the run's extra width is tracking.
 *      Measured: 0.000–0.060 units (curve flattening only).
 *
 * `WIDTH_PROBE=1 node --test test/width-plan.test.ts` prints the table.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFont, openVariableFont } from '../src/font/parser.ts';
import { AnalysisClient } from '../src/worker/client.ts';
import { DEFAULT_PARAMS } from '../src/core/types.ts';
import type { PathCommand } from '../src/core/types.ts';
import { buildGlyphs } from '../src/engine/glyphs.ts';
import type { RenderGlyph } from '../src/engine/glyphs.ts';
import { buildWidthLadder } from '../src/engine/width-ladder.ts';
import {
  resolveFrame,
  layoutFrame,
  maxRunWidth,
  runWidth,
  singleStepPlan,
  buildWeightedRemap,
  residualSlopes,
  cumulativeWeights,
} from '../src/core/width-plan.ts';
import { sampleNormalizedLUT } from '../src/webgl/parity.ts';
import type { WidthPlan, PlanGlyph } from '../src/core/width-plan.ts';
import { layoutRun } from '../src/core/kerning.ts';
import { splitGlyph, remapContours } from '../src/svg/split.ts';
import type { SplitContour } from '../src/svg/split.ts';
import { commandsToContours, evalSegment } from '../src/core/geometry/segments.ts';
import { sampleOutline, sampleBounds } from '../src/core/sampling/outline.ts';
import { computeStraightProfile } from '../src/core/straight-profile.ts';

const FONT_PATH = fileURLToPath(new URL('../playground/public/fonts/RobotoFlex-VF.ttf', import.meta.url));
const HAVE_FONT = existsSync(FONT_PATH);
const UPM = 1000;
const BASE = { wght: 700, opsz: 120 };
const TEXT = 'Ayvwkx';

const THICKNESS_MIN = 0.85;
const THICKNESS_MAX = 1.1;
const STRAIGHTNESS_TOL = 0.04;
const SHAPE_TOL = 1;

function fontBuffer(): ArrayBuffer {
  const buf = readFileSync(FONT_PATH);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

interface Built {
  glyphs: RenderGlyph[];
  plan: WidthPlan;
}

let cached: Promise<Built> | null = null;
function build(): Promise<Built> {
  cached ??= (async () => {
    const ab = fontBuffer();
    const parsed = parseFont(ab, { fontSize: UPM, variations: BASE });
    const client = new AnalysisClient({ inline: true });
    const glyphs = await buildGlyphs({ parsed, wdthAxis: null }, TEXT, client, DEFAULT_PARAMS, UPM);
    const plan = await buildWidthLadder({
      font: openVariableFont(ab, { fontSize: UPM })!,
      base: BASE,
      glyphs,
      client,
      params: DEFAULT_PARAMS,
      unitsPerEm: UPM,
      minStretch: 1,
      maxStretch: 3,
    });
    return { glyphs, plan };
  })();
  return cached;
}

// ── outline → polygons (run space) ──────────────────────────────────────────

type Poly = Array<[number, number]>;

function contoursToPolys(contours: SplitContour[] | ReturnType<typeof commandsToContours>, dx = 0): Poly[] {
  const out: Poly[] = [];
  for (const segs of contours) {
    const ring: Poly = [];
    for (const seg of segs) {
      const n = seg.type === 'L' ? 1 : 16;
      for (let k = 0; k < n; k++) {
        const p = evalSegment(seg, k / n);
        ring.push([p.x + dx, p.y]);
      }
    }
    if (ring.length > 2) out.push(ring);
  }
  return out;
}

const commandPolys = (cmds: PathCommand[], dx = 0) => contoursToPolys(commandsToContours(cmds), dx);

/** Ink intervals on scanline y (nonzero winding). */
function scan(polys: Poly[], y: number): Array<[number, number]> {
  const xs: Array<{ x: number; d: number }> = [];
  for (const ring of polys) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x0, y0] = ring[j];
      const [x1, y1] = ring[i];
      if ((y0 <= y && y < y1) || (y1 <= y && y < y0)) {
        xs.push({ x: x0 + ((y - y0) / (y1 - y0)) * (x1 - x0), d: y1 > y0 ? 1 : -1 });
      }
    }
  }
  xs.sort((a, b) => a.x - b.x);
  const out: Array<[number, number]> = [];
  let w = 0;
  let start = 0;
  for (const c of xs) {
    const was = w !== 0;
    w += c.d;
    if (!was && w !== 0) start = c.x;
    else if (was && w === 0) out.push([start, c.x]);
  }
  return out;
}

function fit(ys: number[], xs: number[]): { m: number; maxResidual: number } {
  const n = ys.length;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (ys[i] - my) * (xs[i] - mx);
    syy += (ys[i] - my) ** 2;
  }
  const m = sxy / syy;
  let maxResidual = 0;
  for (let i = 0; i < n; i++) maxResidual = Math.max(maxResidual, Math.abs(xs[i] - (mx + m * (ys[i] - my))));
  return { m, maxResidual };
}

interface StrokeMetric {
  thickness: number;
  straightness: number; // max edge residual / thickness
}

/** Outer-left and outer-right stroke of a glyph in its upper arm band. */
function outerStrokes(polys: Poly[], top: number): [StrokeMetric, StrokeMetric] {
  const xh = -top; // SVG-down: baseline 0, x-height at `top` < 0
  const ys: number[] = [];
  for (let k = 0; k <= 24; k++) ys.push(top + xh * (0.15 + (0.25 * k) / 24));
  const L = { yl: [] as number[], xl: [] as number[], xr: [] as number[] };
  const R = { yl: [] as number[], xl: [] as number[], xr: [] as number[] };
  for (const y of ys) {
    const iv = scan(polys, y);
    if (iv.length < 2) continue;
    L.yl.push(y);
    L.xl.push(iv[0][0]);
    L.xr.push(iv[0][1]);
    R.yl.push(y);
    R.xl.push(iv[iv.length - 1][0]);
    R.xr.push(iv[iv.length - 1][1]);
  }
  const metric = (s: typeof L): StrokeMetric => {
    const a = fit(s.yl, s.xl);
    const b = fit(s.yl, s.xr);
    const m = (a.m + b.m) / 2;
    let h = 0;
    for (let i = 0; i < s.yl.length; i++) h += s.xr[i] - s.xl[i];
    h /= s.yl.length;
    const thickness = h / Math.sqrt(1 + m * m);
    return { thickness, straightness: Math.max(a.maxResidual, b.maxResidual) / thickness };
  };
  return [metric(L), metric(R)];
}

/** Max over points of `a` of the distance to the outline `b` (directed Hausdorff). */
function hausdorff(a: Poly[], b: Poly[]): number {
  let worst = 0;
  for (const ring of a) {
    for (const [px, py] of ring) {
      let best = Infinity;
      for (const r of b) {
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
          const [x0, y0] = r[j];
          const [x1, y1] = r[i];
          const dx = x1 - x0;
          const dy = y1 - y0;
          const L = dx * dx + dy * dy;
          const t = L > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / L)) : 0;
          best = Math.min(best, Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy)));
        }
      }
      worst = Math.max(worst, best);
    }
  }
  return worst;
}

/** Polygons of glyph `i` as the plan lays it out at `stretch`. */
function planPolys(plan: WidthPlan, stretch: number, i: number): Poly[] {
  const frame = resolveFrame(plan, stretch);
  const lay = layoutFrame(plan, frame);
  const fg = lay.glyphs[i];
  if (fg.remap) {
    const g = plan.steps[frame.k1].glyphs[i];
    return contoursToPolys(remapContours(splitGlyph(g.commands, g.bounds, g.weights.length), fg.remap, fg.penX));
  }
  const cmds = fg.commands ?? plan.steps[frame.k1].glyphs[i].commands;
  return commandPolys(cmds, fg.penX);
}

/** Polygons of glyph `i` under the pre-fix model (flex slices, share cap 4). */
function legacyPolys(glyphs: RenderGlyph[], stretch: number, i: number): Poly[] {
  const lay = layoutRun(
    glyphs.map((g) => ({ profile: g.flex, bounds: g.bounds, advanceWidth: g.advanceWidth, kernBefore: g.kernBefore })),
    { stretch, axis: 'x', origin: 0 },
  );
  const g = glyphs[i];
  return contoursToPolys(remapContours(splitGlyph(g.commands, g.bounds, g.flex.length), lay.glyphs[i].remap, lay.glyphs[i].penX));
}

const DIAGONAL = ['y', 'v', 'w', 'x'];

test('straight profile: diagonal-only glyphs get zero weight; o / e / H get their horizontal spans', { skip: !HAVE_FONT }, () => {
  const f = parseFont(fontBuffer(), { fontSize: UPM, variations: { ...BASE, wdth: 151, XTRA: 603 } });
  const total = (ch: string): number => {
    const g = f.glyph(ch)!;
    const o = sampleOutline(g.commands, { samplesPerSegment: 24 });
    const bb = sampleBounds(o);
    const p = computeStraightProfile(o, {
      slices: 96,
      bounds: { min: bb.minX, max: bb.maxX },
      crossBounds: { min: bb.minY, max: bb.maxY },
    });
    let s = 0;
    for (const v of p) s += v;
    return s / 96;
  };
  for (const ch of ['y', 'v', 'w', 'x', 'k', 'A']) assert.equal(total(ch), 0, `${ch} has no straight column`);
  for (const ch of ['o', 'e', 'H']) assert.ok(total(ch) > 0.15, `${ch} has straight columns (${total(ch).toFixed(2)})`);
});

test('width plan: real instances first, exact widths, monotonic, residual only past the widest', { skip: !HAVE_FONT }, async () => {
  const { plan } = await build();
  assert.ok(plan.steps.length >= 3, `ladder has several real instances (${plan.steps.length})`);
  for (let k = 1; k < plan.steps.length; k++) assert.ok(plan.steps[k].width > plan.steps[k - 1].width, 'ascending widths');
  const top = plan.steps[plan.steps.length - 1];
  assert.equal(top.location?.wdth, 151, 'top step at wdth max');
  assert.equal(top.location?.XTRA, 603, 'top step at XTRA max');
  const base = plan.steps[plan.base].width;
  let prev = 0;
  for (let s = 1; s <= 3.0001; s += 0.05) {
    const f = resolveFrame(plan, s);
    const w = layoutFrame(plan, f).width;
    assert.ok(Math.abs(w - s * base) < 1e-6 * base, `run width ${w} = ${s}× ${base}`);
    assert.ok(w > prev, 'monotonic');
    prev = w;
    if (s * base <= top.width) assert.equal(f.growth, 0, 'no residual inside the ladder');
  }
  assert.ok(Math.abs(maxRunWidth(plan, 3) - 3 * base) < 1e-6 * base);
});

test('width plan: a lone diagonal-only glyph saturates at its widest design instead of distorting', async () => {
  // synthetic 'v' with no straight column, one glyph ⇒ nothing may stretch
  const v: PlanGlyph = {
    commands: [
      { type: 'M', x: 0, y: -500 }, { type: 'L', x: 120, y: -500 }, { type: 'L', x: 250, y: -100 },
      { type: 'L', x: 380, y: -500 }, { type: 'L', x: 500, y: -500 }, { type: 'L', x: 310, y: 0 },
      { type: 'L', x: 190, y: 0 }, { type: 'Z' },
    ],
    bounds: { min: 0, max: 500 },
    advanceWidth: 500,
    kernBefore: 0,
    bbox: { minX: 0, minY: -500, maxX: 500, maxY: 0 },
    weights: new Float32Array(96),
  };
  const plan = singleStepPlan([v], 100);
  const f = resolveFrame(plan, 2.5);
  assert.equal(f.saturated, true);
  assert.equal(f.growth, 0);
  assert.equal(layoutFrame(plan, f).width, runWidth([v]));
  // two of them: the extra width becomes one even gap, glyphs untouched
  const two = singleStepPlan([v, { ...v }], 100);
  const f2 = resolveFrame(two, 2);
  const lay = layoutFrame(two, f2);
  assert.equal(lay.width, 2000);
  assert.ok(Math.abs(lay.glyphs[0].inkRight - lay.glyphs[0].inkLeft - 500) < 1e-9, 'glyph keeps its width');
  assert.ok(Math.abs(lay.glyphs[1].inkLeft - lay.glyphs[0].inkRight - 1000) < 1e-9, 'gap took the extra width');
  // straight columns take residual proportionally to their weight
  const r = buildWeightedRemap(new Float32Array([0, 1, 1, 0]), { min: 0, max: 400 }, 1);
  assert.equal(r.remap(100), 100);
  assert.equal(r.remap(300), 500);
  assert.equal(r.remap(400), 600);
});

test('y v w x at 2.5×: diagonal thickness change, edge straightness, deviation from the designed instance', { skip: !HAVE_FONT }, async () => {
  const { glyphs, plan } = await build();
  const top = plan.steps[plan.steps.length - 1];
  const rows: string[] = [];
  for (const ch of DIAGONAL) {
    const i = glyphs.findIndex((g) => g.char === ch);
    const xTop = Math.min(...glyphs.filter((g) => 'vwx'.includes(g.char)).map((g) => g.bbox.minY));
    const before = outerStrokes(planPolys(plan, 1, i), xTop);
    const after = outerStrokes(planPolys(plan, 2.5, i), xTop);
    const legacy = outerStrokes(legacyPolys(glyphs, 2.5, i), xTop);
    for (let side = 0; side < 2; side++) {
      const ratio = after[side].thickness / before[side].thickness;
      const oldRatio = legacy[side].thickness / before[side].thickness;
      rows.push(
        `${ch} ${side ? 'R' : 'L'}  t1=${before[side].thickness.toFixed(1)}  ` +
          `new ×${ratio.toFixed(3)} straight ${after[side].straightness.toFixed(3)}   ` +
          `old ×${oldRatio.toFixed(3)} straight ${legacy[side].straightness.toFixed(3)}`,
      );
      assert.ok(
        ratio >= THICKNESS_MIN && ratio <= THICKNESS_MAX,
        `${ch} ${side ? 'right' : 'left'} stroke thickness ×${ratio.toFixed(3)}`,
      );
      // the metric does catch the original defect
      assert.ok(oldRatio > THICKNESS_MAX, `old model thickened ${ch} ×${oldRatio.toFixed(3)}`);
      assert.ok(after[side].straightness <= STRAIGHTNESS_TOL, `${ch} edge straightness ${after[side].straightness.toFixed(3)}`);
    }
    // the 2.5× glyph IS the widest designed instance (pen-aligned)
    const frame = resolveFrame(plan, 2.5);
    const fg = layoutFrame(plan, frame).glyphs[i];
    const designed = top.glyphs[i].commands;
    const drawn = planPolys(plan, 2.5, i);
    const ref = commandPolys(designed, fg.penX);
    const dev = Math.max(hausdorff(drawn, ref), hausdorff(ref, drawn));
    rows.push(`${ch} shape deviation from widest instance: ${dev.toFixed(3)} units`);
    assert.ok(dev <= SHAPE_TOL, `${ch} deviates ${dev} units from the designed instance`);
  }
  // The metric must catch the original defect: at least one old stroke breaks each bound.
  const xTop = Math.min(...glyphs.filter((g) => 'vwx'.includes(g.char)).map((g) => g.bbox.minY));
  const legacyY = outerStrokes(legacyPolys(glyphs, 2.5, glyphs.findIndex((g) => g.char === 'y')), xTop);
  assert.ok(legacyY.some((m) => m.straightness > STRAIGHTNESS_TOL), 'old model bends y');
  if (process.env.WIDTH_PROBE) console.log(rows.join('\n'));
});

test('GPU residual form matches the CPU layout (WebGL parity)', () => {
  // two glyphs with straight columns + a blank, so tracking, word space and ink all grow
  const mk = (min: number, max: number, w: number[]): PlanGlyph => ({
    commands: [{ type: 'M', x: min, y: -500 }, { type: 'L', x: max, y: -500 }, { type: 'L', x: max, y: 0 }, { type: 'L', x: min, y: 0 }, { type: 'Z' }],
    bounds: { min, max },
    advanceWidth: max + 40,
    kernBefore: 0,
    bbox: { minX: min, minY: -500, maxX: max, maxY: 0 },
    weights: Float32Array.from(w),
  });
  const blank: PlanGlyph = { ...mk(0, 0, [0, 0, 0, 0]), commands: [], bounds: { min: 0, max: 0 }, advanceWidth: 250 };
  const glyphs = [mk(30, 530, [0, 1, 0.5, 0]), blank, { ...mk(20, 420, [0.2, 0, 0, 1]), kernBefore: -15 }];
  const plan = singleStepPlan(glyphs, 100);
  for (const stretch of [1.3, 2, 3.7]) {
    const frame = resolveFrame(plan, stretch);
    const lay = layoutFrame(plan, frame);
    const slopes = residualSlopes(plan, 0, frame.growth);
    let prefix = 0;
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i];
      prefix += g.kernBefore;
      const L = prefix + g.bounds.min;
      prefix += g.advanceWidth;
      if (!(g.bounds.max > g.bounds.min)) continue;
      const W = g.bounds.max - g.bounds.min;
      const C = cumulativeWeights(g.weights); // Float32, as uploaded to the GPU
      for (let k = 0; k <= 40; k++) {
        const u = k / 40;
        const gpu = L + W * u + frame.growth * (slopes[i].left + slopes[i].ink * sampleNormalizedLUT(C, u));
        const cpu = lay.glyphs[i].penX + lay.glyphs[i].remap!.remap(g.bounds.min + W * u);
        assert.ok(Math.abs(gpu - cpu) < 1e-3, `glyph ${i} u=${u} gpu ${gpu} cpu ${cpu}`);
      }
    }
  }
});
