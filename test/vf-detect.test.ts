/**
 * vf-detect.test.ts — Tier-0 fvar `wdth` axis detection (pure, Node).
 *
 * Two layers:
 *  1. SYNTHETIC (mandatory): a mocked opentype.js `fvar` structure — asserts the
 *     axis {min, default, max} is read exactly and non-wdth fonts return null.
 *  2. REAL FONT (best-effort): if a system variable font exposing `wdth` is
 *     found, assert the axis is read back with a sane shape. Skipped gracefully
 *     when no such font exists. See report: macOS Skia.ttf carries a `wdth` axis
 *     but in legacy MULTIPLIER units (~0.62/1/1.3), not the spec percentage
 *     scale — so we assert SHAPE here, not percentage semantics.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import opentype from 'opentype.js';
import { getWdthAxis, hasWdthAxis } from '../src/vf/detect.ts';
import type { FvarBearingFont } from '../src/vf/detect.ts';

// ---- 1. SYNTHETIC (mandatory) ------------------------------------------------

const synthWdth: FvarBearingFont = {
  tables: {
    fvar: {
      axes: [
        { tag: 'wght', minValue: 100, defaultValue: 400, maxValue: 900 },
        { tag: 'wdth', minValue: 75, defaultValue: 100, maxValue: 125 },
      ],
    },
  },
};

test('getWdthAxis reads {min,default,max} exactly from a synthetic fvar', () => {
  const axis = getWdthAxis(synthWdth);
  assert.deepEqual(axis, { min: 75, default: 100, max: 125 });
  assert.equal(hasWdthAxis(synthWdth), true);
});

test('getWdthAxis returns null when there is no wdth axis', () => {
  const noWdth: FvarBearingFont = {
    tables: { fvar: { axes: [{ tag: 'wght', minValue: 100, defaultValue: 400, maxValue: 900 }] } },
  };
  assert.equal(getWdthAxis(noWdth), null);
  assert.equal(hasWdthAxis(noWdth), false);
});

test('getWdthAxis returns null for a non-variable font (no fvar table)', () => {
  assert.equal(getWdthAxis({}), null);
  assert.equal(getWdthAxis({ tables: {} }), null);
  assert.equal(getWdthAxis({ tables: { fvar: { axes: [] } } }), null);
  assert.equal(getWdthAxis(null), null);
  assert.equal(getWdthAxis(undefined), null);
});

// ---- 2. REAL FONT (best-effort) ---------------------------------------------

const VF_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Skia.ttf',
  '/System/Library/Fonts/SFNSRounded.ttf', // has axes but no wdth — exercises null path
];

function loadWdthFont(): { font: FvarBearingFont; path: string } | null {
  for (const path of VF_CANDIDATES) {
    if (!existsSync(path)) continue;
    try {
      const buf = readFileSync(path);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      const font = opentype.parse(ab) as unknown as FvarBearingFont;
      if (getWdthAxis(font)) return { font, path };
    } catch {
      // try next
    }
  }
  return null;
}

test('getWdthAxis reads a REAL system variable font with a wdth axis (or skips)', (t) => {
  const found = loadWdthFont();
  if (!found) {
    t.skip('no system variable font with a wdth axis found on this machine');
    return;
  }
  const axis = getWdthAxis(found.font);
  assert.ok(axis, `expected a wdth axis from ${found.path}`);
  // Shape assertions only — real fonts (incl. legacy multiplier-scale Skia)
  // must satisfy min <= default <= max with a positive, finite min.
  assert.ok(Number.isFinite(axis!.min) && axis!.min > 0, 'min positive & finite');
  assert.ok(axis!.min <= axis!.default, 'min <= default');
  assert.ok(axis!.default <= axis!.max, 'default <= max');
  assert.ok(axis!.max > axis!.min, 'axis has a real range');
});
