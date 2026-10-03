/**
 * interaction-axis-warning.test.ts — 0.1.x renders horizontal stretching only.
 * 'vertical' / 'dual' are accepted (and reported back as given) but warn ONCE
 * per axis so the gap is not silent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTicker } from '../src/interaction/ticker.ts';
import { createStretchController } from '../src/interaction/stretch-controller.ts';

const inert = { requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 };

test('unimplemented axes warn once each; horizontal never warns', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const ticker = createTicker(inert);
  const make = (axis: 'horizontal' | 'vertical' | 'dual') =>
    createStretchController({ trigger: 'custom', ticker, axis });

  assert.equal(make('horizontal').axis, 'horizontal');
  assert.equal(warn.mock.callCount(), 0);

  assert.equal(make('vertical').axis, 'vertical');
  assert.equal(make('vertical').axis, 'vertical');
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /not implemented in 0\.1\.x/);
  assert.equal(warn.mock.calls[0].arguments[1], 'vertical');

  assert.equal(make('dual').axis, 'dual');
  make('dual');
  assert.equal(warn.mock.callCount(), 2);
  assert.equal(warn.mock.calls[1].arguments[1], 'dual');
});
