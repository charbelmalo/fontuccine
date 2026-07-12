/**
 * interaction-stimuli.test.ts — R3/R4 guarantees for DOM stimuli.
 *
 * Uses Node's global EventTarget/Event (no jsdom) + injected observer factories.
 * The key invariant: raw event handlers record input ONLY and NEVER read layout
 * (getBoundingClientRect); measurement happens exclusively in the READ phase.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTicker } from '../src/interaction/ticker.ts';
import type { FrameScheduler } from '../src/interaction/ticker.ts';
import { createProximityStimulus } from '../src/interaction/stimuli/proximity.ts';
import { createScrollVelocityStimulus } from '../src/interaction/stimuli/scroll-velocity.ts';
import { createHoverStimulus } from '../src/interaction/stimuli/hover.ts';

function inertScheduler(): FrameScheduler {
  return { requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 };
}

function pointerEvent(type: string, x: number, y: number, pointerId = 1): Event {
  const e = new Event(type);
  Object.assign(e, { clientX: x, clientY: y, pointerId });
  return e;
}

test('R3/R4: proximity handler does NOT read layout; rect measured in READ phase', () => {
  let rectReads = 0;
  const el = {
    getBoundingClientRect() {
      rectReads += 1;
      return { left: 0, right: 100, top: 0, bottom: 100 };
    },
  };
  const pointerTarget = new EventTarget();
  const scrollTarget = new EventTarget();
  const t = createTicker(inertScheduler());
  const stim = createProximityStimulus({
    element: el,
    radius: 200,
    pointerTarget,
    scrollTarget,
    resizeObserverFactory: () => ({ observe() {}, disconnect() {} }),
  });
  stim.attach(t);

  // Fire a pointer move: the handler must record position but read NO layout.
  pointerTarget.dispatchEvent(pointerEvent('pointermove', 50, 50));
  assert.equal(rectReads, 0, 'handler must not call getBoundingClientRect');

  // Only the READ phase measures.
  t.frame(0);
  assert.ok(rectReads >= 1, 'rect measured in READ phase');
  assert.ok(stim.value > 0.99, 'pointer inside element ⇒ proximity ≈ 1');

  // Cached: another frame with no invalidation does not re-measure.
  const after = rectReads;
  t.frame(16);
  assert.equal(rectReads, after, 'rect is cached across frames (R4)');

  // Scroll invalidates the cache → next READ re-measures (still no read in handler).
  scrollTarget.dispatchEvent(new Event('scroll'));
  assert.equal(rectReads, after, 'scroll handler does not read layout');
  t.frame(32);
  assert.equal(rectReads, after + 1, 're-measured after scroll invalidation');

  stim.detach();
});

test('proximity: nearest of multiple pointers wins', () => {
  const el = {
    getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 100 }),
  };
  const pointerTarget = new EventTarget();
  const t = createTicker(inertScheduler());
  const stim = createProximityStimulus({
    element: el,
    radius: 200,
    pointerTarget,
    scrollTarget: new EventTarget(),
    resizeObserverFactory: () => ({ observe() {}, disconnect() {} }),
  });
  stim.attach(t);
  pointerTarget.dispatchEvent(pointerEvent('pointermove', 300, 300, 1)); // far
  pointerTarget.dispatchEvent(pointerEvent('pointermove', 50, 50, 2)); // inside
  t.frame(0);
  assert.ok(stim.value > 0.99, 'nearest pointer dominates');
  stim.detach();
});

test('scroll-velocity: handler records raw only; velocity smooths then decays to 0', () => {
  const scrollTarget = new EventTarget();
  let y = 0;
  let clock = 0;
  const t = createTicker(inertScheduler());
  const stim = createScrollVelocityStimulus({
    target: scrollTarget,
    getScrollY: () => y,
    now: () => clock,
    smoothing: 0.5,
  });
  stim.attach(t);

  // Simulate two scroll events 16ms apart moving 160px ⇒ 10_000 px/s raw.
  clock = 0;
  y = 0;
  scrollTarget.dispatchEvent(new Event('scroll'));
  clock = 16;
  y = 160;
  scrollTarget.dispatchEvent(new Event('scroll'));

  t.frame(0);
  assert.ok(stim.value > 0, `velocity registered (value ${stim.value})`);

  // No more scrolling → decays toward 0.
  for (let i = 0; i < 200; i++) t.frame(i + 1);
  assert.ok(Math.abs(stim.value) < 1e-2, `velocity decays to ~0 (value ${stim.value})`);
  stim.detach();
});

test('hover: enter → 1, leave → 0 (raw target for the spring to smooth)', () => {
  const el = new EventTarget();
  const t = createTicker(inertScheduler());
  const stim = createHoverStimulus({ element: el });
  stim.attach(t);
  assert.equal(stim.value, 0);
  el.dispatchEvent(new Event('pointerenter'));
  assert.equal(stim.value, 1);
  el.dispatchEvent(new Event('pointerleave'));
  assert.equal(stim.value, 0);
  stim.detach();
});

test('detach removes listeners (no value change after teardown)', () => {
  const el = new EventTarget();
  const t = createTicker(inertScheduler());
  const stim = createHoverStimulus({ element: el });
  stim.attach(t);
  stim.detach();
  el.dispatchEvent(new Event('pointerenter'));
  assert.equal(stim.value, 0, 'no listener fires after detach');
});
