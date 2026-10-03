/** engine/variations.ts — computed CSS font properties → axis request. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVariationRequest, parseVariationSettings, stretchToWdth, weightToWght, styleToAxes } from '../src/engine/variations.ts';

test('font-weight / font-stretch keywords and numbers resolve to wght / wdth', () => {
  assert.equal(weightToWght('700'), 700);
  assert.equal(weightToWght('bold'), 700);
  assert.equal(weightToWght('normal'), 400);
  assert.equal(weightToWght('550.5'), 550.5);
  assert.equal(stretchToWdth('100%'), 100);
  assert.equal(stretchToWdth('condensed'), 75);
  assert.equal(stretchToWdth('ultra-expanded'), 200);
  assert.equal(stretchToWdth('137.5%'), 137.5);
});

test('font-style → ital / slnt (oblique angles flip sign)', () => {
  assert.deepEqual(styleToAxes('normal'), {});
  assert.deepEqual(styleToAxes('italic'), { ital: 1 });
  assert.deepEqual(styleToAxes('oblique'), { slnt: -14 });
  assert.deepEqual(styleToAxes('oblique 10deg'), { slnt: -10 });
});

test('font-variation-settings parses tags and overrides the high-level properties', () => {
  assert.deepEqual(parseVariationSettings('normal'), {});
  assert.deepEqual(parseVariationSettings('"wght" 650, "GRAD" -50, "opsz" 12.5'), { wght: 650, GRAD: -50, opsz: 12.5 });
  const req = resolveVariationRequest({
    fontWeight: '700',
    fontStretch: '100%',
    fontSize: '128px',
    fontOpticalSizing: 'auto',
    fontVariationSettings: '"wght" 300, "wdth" 120',
  });
  assert.deepEqual(req, { wght: 300, wdth: 120, opsz: 128 });
});

test('the playground hero (700 / 128px / optical sizing auto) resolves to wght 700 + opsz 128', () => {
  const req = resolveVariationRequest({ fontWeight: '700', fontStretch: '100%', fontStyle: 'normal', fontSize: '128px', fontOpticalSizing: 'auto', fontVariationSettings: 'normal' });
  assert.deepEqual(req, { wght: 700, wdth: 100, opsz: 128 });
  const noOpsz = resolveVariationRequest({ fontWeight: '400', fontSize: '20px', fontOpticalSizing: 'none' });
  assert.deepEqual(noOpsz, { wght: 400 });
  assert.deepEqual(resolveVariationRequest({}), {});
});
