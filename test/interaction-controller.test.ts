/**
 * interaction-controller.test.ts — StretchController mapping + R5/R7 behaviour.
 *
 * Deterministic via a manual ticker (frames driven by hand) and an injected
 * stimulus, so no DOM/rAF is required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTicker } from '../src/interaction/ticker.ts';
import type { FrameScheduler } from '../src/interaction/ticker.ts';
import { createStretchController } from '../src/interaction/stretch-controller.ts';
import type { Stimulus } from '../src/interaction/stimuli/types.ts';

function inertScheduler(): FrameScheduler {
  return { requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 };
}

/** Stimulus whose value is set directly by the test. */
function fakeStimulus(): Stimulus & { v: number } {
  return {
    v: 0,
    get value() {
      return this.v;
    },
    attach() {},
    detach() {},
  };
}

/** Advance the controller `n` frames at 60fps starting from t0. */
function run(t: ReturnType<typeof createTicker>, n: number, t0 = 0): void {
  for (let i = 0; i < n; i++) t.frame(t0 + (i + 1) * 16.6667);
}

test('R7: reduced motion pins output to the resting value', () => {
  const t = createTicker(inertScheduler());
  const c = createStretchController({
    trigger: 'custom',
    ticker: t,
    isReducedMotion: () => true,
    respectReducedMotion: true,
    maxStretchRatio: 4.5,
  });
  c.set(3); // would stretch, but reduced motion pins to 1
  run(t, 300);
  assert.ok(Math.abs(c.value - 1) < 1e-6, `pinned to resting (value ${c.value})`);
  assert.equal(c.target, 1);
  c.destroy();
});

test('respectReducedMotion:false ignores the preference', () => {
  const t = createTicker(inertScheduler());
  const c = createStretchController({
    trigger: 'custom',
    ticker: t,
    isReducedMotion: () => true,
    respectReducedMotion: false,
    maxStretchRatio: 3,
  });
  c.set(2);
  run(t, 400);
  assert.ok(Math.abs(c.value - 2) < 1e-2, `still animates (value ${c.value})`);
  c.destroy();
});

test('scroll-velocity target clamps at maxStretchRatio', () => {
  const t = createTicker(inertScheduler());
  const stim = fakeStimulus();
  stim.v = 100_000; // absurd velocity
  const c = createStretchController({
    trigger: 'scroll-velocity',
    ticker: t,
    stimulus: stim,
    maxStretchRatio: 2,
    minStretchRatio: 1,
    velocityToStretch: 0.002,
  });
  let maxSeen = -Infinity;
  for (let i = 0; i < 500; i++) {
    t.frame((i + 1) * 16.6667);
    maxSeen = Math.max(maxSeen, c.value);
  }
  assert.equal(c.target, 2, 'target clamped to max');
  assert.ok(maxSeen <= 2 + 1e-9, `never exceeds max (max ${maxSeen})`);
  assert.ok(Math.abs(c.value - 2) < 1e-2, 'settles at max');
  c.destroy();
});

test('custom .set() drives value through the spring, staying within [min,max]', () => {
  const t = createTicker(inertScheduler());
  const c = createStretchController({
    trigger: 'custom',
    ticker: t,
    minStretchRatio: 1,
    maxStretchRatio: 3,
  });
  c.set(1.8);
  let minSeen = Infinity;
  let maxSeen = -Infinity;
  for (let i = 0; i < 500; i++) {
    t.frame((i + 1) * 16.6667);
    minSeen = Math.min(minSeen, c.value);
    maxSeen = Math.max(maxSeen, c.value);
  }
  assert.ok(Math.abs(c.value - 1.8) < 1e-2, `reaches target (value ${c.value})`);
  assert.ok(minSeen >= 1 - 1e-9 && maxSeen <= 3 + 1e-9, 'value never left [min,max]');
  c.destroy();
});

test('target never leaves [min,max] regardless of input', () => {
  const t = createTicker(inertScheduler());
  const c = createStretchController({
    trigger: 'custom',
    ticker: t,
    minStretchRatio: 1,
    maxStretchRatio: 2,
  });
  c.set(99);
  run(t, 1);
  assert.equal(c.target, 2, 'over-range clamps to max');
  c.set(-5);
  run(t, 1);
  assert.equal(c.target, 1, 'under-range clamps to min');
  c.destroy();
});

test('proximity maps 0..1 into [resting, max]', () => {
  const t = createTicker(inertScheduler());
  const stim = fakeStimulus();
  stim.v = 0.5; // half proximity
  const c = createStretchController({
    trigger: 'mouse-proximity',
    ticker: t,
    stimulus: stim,
    maxStretchRatio: 3, // resting 1 + 0.5*(3-1) = 2
  });
  run(t, 500);
  assert.ok(Math.abs(c.value - 2) < 1e-2, `half proximity → mid stretch (value ${c.value})`);
  c.destroy();
});

test('easingCurve smoother is an alternative to physics', () => {
  const t = createTicker(inertScheduler());
  const c = createStretchController({
    trigger: 'custom',
    ticker: t,
    easingCurve: 'cubic-bezier(0.4, 0, 0.2, 1)',
    easingDuration: 0.3,
    maxStretchRatio: 4,
  });
  c.set(2);
  run(t, 120); // ~2s, well past the 0.3s tween
  assert.ok(Math.abs(c.value - 2) < 1e-3, `bezier tween reaches target (value ${c.value})`);
  c.destroy();
});

test('destroy() unsubscribes: no further frames mutate value', () => {
  const t = createTicker(inertScheduler());
  const c = createStretchController({ trigger: 'custom', ticker: t, maxStretchRatio: 3 });
  c.set(2);
  run(t, 500);
  const settled = c.value;
  c.destroy();
  c.set(3); // ignored — detached
  run(t, 200);
  assert.equal(c.value, settled, 'value frozen after destroy');
});

test('velocity: exposed per second while moving, exactly 0 at rest', () => {
  const t = createTicker(inertScheduler());
  const c = createStretchController({ trigger: 'custom', ticker: t, maxStretchRatio: 3 });
  assert.equal(c.velocity, 0, 'at rest before any input');
  c.set(2);
  run(t, 4);
  assert.notEqual(c.velocity, 0, 'moving toward the target');
  assert.ok(c.velocity > 0, `velocity points toward the larger target (${c.velocity})`);
  // Per second, not per frame: a 1→2 critically-damped spring (ω≈13/s) peaks
  // near 4.8 stretch/s — a per-frame value would be ~60× smaller.
  assert.ok(c.velocity > 1, `per-second magnitude (${c.velocity})`);
  run(t, 600, 4 * 16.6667);
  assert.equal(c.velocity, 0, 'exactly 0 once settled');
  c.destroy();
});
