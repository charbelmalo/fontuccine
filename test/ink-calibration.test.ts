/**
 * Ink calibration: the probe that measures how much bolder the host's text
 * rasteriser draws a font than its outline (engine/ink-calibration.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stretchKeyword, parseInkColor, outlinePerimeter, coverageSum, canvasFontFor,
  measureInkDilation, __resetInkCalibrationCache, MAX_INK_DILATION,
} from '../src/engine/ink-calibration.ts';
import { rect } from './helpers.ts';

test('stretchKeyword maps computed font-stretch to canvas keywords (±0.5 %)', () => {
  assert.equal(stretchKeyword('100%'), 'normal');
  assert.equal(stretchKeyword('normal'), 'normal');
  assert.equal(stretchKeyword('75%'), 'condensed');
  assert.equal(stretchKeyword('112.5%'), 'semi-expanded');
  assert.equal(stretchKeyword('99.75%'), 'normal');
  assert.equal(stretchKeyword('93%'), null, 'no keyword within 0.5 %');
  assert.equal(stretchKeyword('bogus'), null);
});

test('parseInkColor reads rgb()/rgba()/hex and drops alpha', () => {
  assert.deepEqual(parseInkColor('rgb(232, 234, 242)'), [232, 234, 242]);
  assert.deepEqual(parseInkColor('rgba(1, 2, 3, 0.5)'), [1, 2, 3]);
  assert.deepEqual(parseInkColor('#0a0b0c'), [10, 11, 12]);
  assert.equal(parseInkColor('currentColor'), null);
});

test('outlinePerimeter: rectangle exact, curves flattened within 0.5 %', () => {
  assert.equal(outlinePerimeter(rect), 2 * (100 + 700));
  // a circle of radius 100 from four cubic arcs (kappa 0.5523)
  const k = 0.5522847498 * 100;
  const circle = [
    { type: 'M', x: 100, y: 0 },
    { type: 'C', x1: 100, y1: k, x2: k, y2: 100, x: 0, y: 100 },
    { type: 'C', x1: -k, y1: 100, x2: -100, y2: k, x: -100, y: 0 },
    { type: 'C', x1: -100, y1: -k, x2: -k, y2: -100, x: 0, y: -100 },
    { type: 'C', x1: k, y1: -100, x2: 100, y2: -k, x: 100, y: 0 },
    { type: 'Z' },
  ] as const;
  const p = outlinePerimeter([...circle]);
  assert.ok(Math.abs(p - 2 * Math.PI * 100) / (2 * Math.PI * 100) < 0.005, `perimeter ${p}`);
});

test('coverageSum projects pixels onto the ink–background axis and clamps', () => {
  const ink: [number, number, number] = [255, 255, 255];
  const bg: [number, number, number] = [0, 0, 0];
  // full ink, half ink, background, over-bright (clamped)
  const data = new Uint8ClampedArray([255, 255, 255, 255, 128, 128, 128, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  const s = coverageSum(data, ink, bg);
  assert.ok(Math.abs(s - (1 + 128 / 255 + 0 + 1)) < 1e-6, `sum ${s}`);
});

test('canvasFontFor refuses instances a canvas font string cannot express', () => {
  const base = { fontFamily: '"Roboto Flex VF"', fontWeight: '700', fontStretch: '100%', fontStyle: 'normal', fontSizePx: 128 };
  assert.deepEqual(canvasFontFor(base), { font: 'normal 700 128px "Roboto Flex VF"', stretch: 'normal' });
  assert.equal(canvasFontFor({ ...base, fontVariationSettings: '"GRAD" 50' }), null, 'custom axes');
  assert.equal(canvasFontFor({ ...base, fontOpticalSizing: 'none' }), null, 'opsz off');
  assert.equal(canvasFontFor({ ...base, fontStretch: '93%' }), null, 'non-keyword stretch');
  assert.equal(canvasFontFor({ ...base, fontStyle: 'oblique 14deg' })?.font, 'oblique 14deg 700 128px "Roboto Flex VF"');
});

/** A fake canvas whose text raster is the path raster dilated by `dilatePx` per edge. */
function fakeDoc(dilatePx: number, opts: { fontsLoaded?: boolean; noCanvas?: boolean } = {}) {
  const calls: string[] = [];
  let mode: 'text' | 'path' = 'path';
  let w = 0, h = 0;
  const ctx = {
    fillStyle: '', font: '', textBaseline: '', textAlign: '',
    setTransform() {}, fillRect() {},
    fillText() { mode = 'text'; calls.push('fillText'); },
    fill() { mode = 'path'; calls.push('fill'); },
    getImageData() {
      // scaled 'I' bar of rect (100×700 units) at scale s: area A, perimeter P; text adds P·d.
      const s = (128 * 1) / 1000;
      const A = 100 * 700 * s * s;
      const P = 2 * (100 + 700) * s;
      const cov = mode === 'text' ? A + P * dilatePx : A;
      // encode the coverage as N fully-inked pixels + one fractional pixel
      const n = Math.floor(cov), frac = cov - n;
      const data = new Uint8ClampedArray((n + 2) * 4);
      for (let i = 0; i < n; i++) data.set([255, 255, 255, 255], i * 4);
      data.set([Math.round(frac * 255), Math.round(frac * 255), Math.round(frac * 255), 255], n * 4);
      data.set([0, 0, 0, 255], (n + 1) * 4);
      return { data };
    },
  };
  const doc = {
    createElement: () => ({
      set width(v: number) { w = v; }, get width() { return w; },
      set height(v: number) { h = v; }, get height() { return h; },
      getContext: opts.noCanvas ? undefined : () => ctx,
    }),
    fonts: { check: () => opts.fontsLoaded ?? true, load: async () => [] },
  } as unknown as Document;
  return { doc, calls };
}

// Path2D is not in Node: give the probe a no-op one.
const g = globalThis as unknown as { Path2D?: unknown };
const hadPath2D = 'Path2D' in g;
const withPath2D = async (fn: () => Promise<void>) => {
  if (!hadPath2D) g.Path2D = class { moveTo() {} lineTo() {} quadraticCurveTo() {} bezierCurveTo() {} closePath() {} };
  try { await fn(); } finally { if (!hadPath2D) delete g.Path2D; }
};

const probeInput = (doc: Document, extra: Record<string, unknown> = {}) => ({
  doc, fontFamily: 'Fake', fontWeight: '700', fontStretch: '100%', fontStyle: 'normal', fontSizePx: 128,
  color: 'rgb(255, 255, 255)', dpr: 1, unitsPerEm: 1000,
  glyphs: [{ char: 'I', glyph: { commands: rect, advanceWidth: 200 } }],
  ...extra,
});

test('measureInkDilation recovers the rasteriser dilation from text-vs-outline coverage', async () => {
  await withPath2D(async () => {
    __resetInkCalibrationCache();
    const { doc, calls } = fakeDoc(0.53);
    const r = await measureInkDilation(probeInput(doc) as never);
    assert.ok(r, 'calibrated');
    assert.equal(r!.source, 'probe');
    assert.ok(Math.abs(r!.dilationDevicePx - 0.53) < 0.02, `dilation ${r!.dilationDevicePx}`);
    assert.equal(r!.dilationCssPx, r!.dilationDevicePx, 'dpr 1');
    assert.deepEqual(calls, ['fillText', 'fill']);
    // second call: cached, no more canvas work
    const r2 = await measureInkDilation(probeInput(doc) as never);
    assert.equal(r2!.source, 'cache');
    assert.equal(calls.length, 2);
  });
});

test('measureInkDilation: negative dilation and the ±MAX clamp', async () => {
  await withPath2D(async () => {
    __resetInkCalibrationCache();
    const thin = await measureInkDilation(probeInput(fakeDoc(-0.3).doc) as never);
    assert.ok(thin && Math.abs(thin.dilationDevicePx + 0.3) < 0.02, `thin ${thin?.dilationDevicePx}`);
    __resetInkCalibrationCache();
    const fat = await measureInkDilation(probeInput(fakeDoc(1.2).doc, { fontFamily: 'Fat' }) as never);
    assert.ok(fat && fat.dilationDevicePx <= MAX_INK_DILATION && fat.dilationDevicePx > 1.1);
  });
});

test('measureInkDilation: DPR scales CSS px; smoothing rule short-circuits at DPR 1', async () => {
  await withPath2D(async () => {
    __resetInkCalibrationCache();
    const aa = await measureInkDilation(probeInput(fakeDoc(0.5).doc, { fontSmoothing: 'antialiased' }) as never);
    assert.deepEqual(aa, { dilationDevicePx: 0, dilationCssPx: 0, source: 'smoothing-rule' });
    __resetInkCalibrationCache();
    const { doc, calls } = fakeDoc(0.5);
    const hi = await measureInkDilation(probeInput(doc, { fontSmoothing: 'antialiased', dpr: 2 }) as never);
    assert.equal(hi!.source, 'probe', 'antialiased has no effect at DPR 2 → probe runs');
    assert.equal(calls.length, 2);
    assert.ok(Math.abs(hi!.dilationCssPx * 2 - hi!.dilationDevicePx) < 1e-9);
  });
});

test('measureInkDilation returns null when it cannot measure', async () => {
  await withPath2D(async () => {
    __resetInkCalibrationCache();
    assert.equal(await measureInkDilation(probeInput(fakeDoc(0.5, { noCanvas: true }).doc) as never), null, 'no 2D canvas');
    __resetInkCalibrationCache();
    assert.equal(await measureInkDilation(probeInput(fakeDoc(0.5, { fontsLoaded: false }).doc) as never), null, 'font not loaded');
    __resetInkCalibrationCache();
    assert.equal(await measureInkDilation(probeInput(fakeDoc(0.5).doc, { fontVariationSettings: '"GRAD" 100' }) as never), null, 'inexpressible instance');
    __resetInkCalibrationCache();
    assert.equal(await measureInkDilation(probeInput(fakeDoc(0.5).doc, { color: 'currentColor' }) as never), null, 'unparseable colour');
    __resetInkCalibrationCache();
    assert.equal(await measureInkDilation(probeInput(fakeDoc(0.5).doc, { glyphs: [] }) as never), null, 'no glyphs');
  });
});
