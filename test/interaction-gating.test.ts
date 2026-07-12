/**
 * interaction-gating.test.ts — R5 IntersectionObserver visibility gating.
 *
 * Drives the gate through the real injection point
 * (`config.intersectionObserverFactory` → `observeVisibility`) with a FAKE
 * IntersectionObserver, so no browser/rAF is involved. Frames are driven by
 * hand via `ticker.frame(now)`.
 *
 * A spy wrapper around the real ticker counts live UPDATE and activity
 * subscriptions so the "unsubscribed on deactivate / re-subscribed (not
 * duplicated) on re-entry" claims are asserted directly rather than inferred.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTicker } from '../src/interaction/ticker.ts';
import type { Ticker, FrameScheduler } from '../src/interaction/ticker.ts';
import { createStretchController } from '../src/interaction/stretch-controller.ts';
import type { Stimulus, RectSource } from '../src/interaction/stimuli/types.ts';
import type {
  IntersectionEntryLike,
  IntersectionObserverLike,
} from '../src/interaction/gating.ts';

function inertScheduler(): FrameScheduler {
  return { requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 };
}

/** Advance `n` frames at 60fps starting from t0 (exclusive). */
function run(t: Ticker, n: number, t0 = 0): void {
  for (let i = 0; i < n; i++) t.frame(t0 + (i + 1) * 16.6667);
}

/**
 * Ticker wrapper over the single real ticker that tracks the number of LIVE
 * (subscribed-and-not-yet-unsubscribed) UPDATE phases and activity predicates.
 * There is exactly one underlying loop — everything delegates to `base`.
 */
type SpyTicker = Ticker & {
  readonly updateSubs: number;
  readonly activitySubs: number;
  readonly baseId: object;
};

function spyTicker(): SpyTicker {
  const base = createTicker(inertScheduler());
  let updateSubs = 0;
  let activitySubs = 0;
  return {
    read: base.read,
    render: base.render,
    update(fn) {
      updateSubs++;
      const un = base.update(fn);
      return () => {
        updateSubs--;
        un();
      };
    },
    onActivity(pred) {
      activitySubs++;
      const un = base.onActivity(pred);
      return () => {
        activitySubs--;
        un();
      };
    },
    wake: base.wake,
    start: base.start,
    stop: base.stop,
    drive: base.drive,
    undrive: base.undrive,
    frame: base.frame,
    get running() {
      return base.running;
    },
    get awake() {
      return base.awake;
    },
    get external() {
      return base.external;
    },
    get updateSubs() {
      return updateSubs;
    },
    get activitySubs() {
      return activitySubs;
    },
    // Identity token: proves the SAME loop is reused across (de)activation.
    baseId: base,
  };
}

/** Stimulus double that records attach/detach so gating side-effects are visible. */
function trackingStimulus(): Stimulus & {
  attached: boolean;
  attachCount: number;
  detachCount: number;
} {
  return {
    attached: false,
    attachCount: 0,
    detachCount: 0,
    get value() {
      return 0;
    },
    attach() {
      this.attached = true;
      this.attachCount++;
    },
    detach() {
      this.attached = false;
      this.detachCount++;
    },
  };
}

/** Fake IntersectionObserver wired through the factory injection point. */
function fakeIntersectionObserver() {
  let cb: ((entries: IntersectionEntryLike[]) => void) | null = null;
  let factoryCount = 0;
  let observeCount = 0;
  let disconnectCount = 0;
  const factory = (
    callback: (entries: IntersectionEntryLike[]) => void,
  ): IntersectionObserverLike => {
    factoryCount++;
    cb = callback;
    return {
      observe() {
        observeCount++;
      },
      unobserve() {},
      disconnect() {
        disconnectCount++;
      },
    };
  };
  return {
    factory,
    emit(isIntersecting: boolean): void {
      if (!cb) throw new Error('IO callback not registered before emit');
      cb([{ isIntersecting }]);
    },
    get factoryCount() {
      return factoryCount;
    },
    get observeCount() {
      return observeCount;
    },
    get disconnectCount() {
      return disconnectCount;
    },
  };
}

const fakeElement = {
  getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0 }),
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {
    return true;
  },
} as unknown as RectSource & EventTarget;

test('R5 gate: starts inactive until the observer reports visibility', () => {
  const t = spyTicker();
  const io = fakeIntersectionObserver();
  const c = createStretchController({
    trigger: 'custom',
    ticker: t,
    element: fakeElement,
    stimulus: trackingStimulus(),
    intersectionObserverFactory: io.factory,
    maxStretchRatio: 3,
  });

  // With a factory present, observeVisibility does NOT fire synchronously:
  // the controller waits for the first entry before doing any work.
  assert.equal(c.active, false, 'inactive before any IO entry');
  assert.equal(io.factoryCount, 1, 'exactly one observer constructed');
  assert.equal(io.observeCount, 1, 'observed the element once');
  assert.equal(t.updateSubs, 0, 'no UPDATE subscription while gated out');
  assert.equal(t.activitySubs, 0, 'no activity predicate while gated out');

  c.destroy();
  assert.equal(io.disconnectCount, 1, 'destroy disconnects the observer');
});

test('R5 gate: offscreen (isIntersecting:false) fully deactivates and freezes the spring', () => {
  const t = spyTicker();
  const io = fakeIntersectionObserver();
  const stim = trackingStimulus();
  const c = createStretchController({
    trigger: 'custom',
    ticker: t,
    element: fakeElement,
    stimulus: stim,
    intersectionObserverFactory: io.factory,
    minStretchRatio: 1,
    maxStretchRatio: 3,
  });

  // --- become visible ---
  io.emit(true);
  assert.equal(c.active, true, 'active once visible');
  assert.equal(stim.attached, true, 'stimulus attached on activate');
  assert.equal(stim.attachCount, 1, 'attached exactly once');
  assert.equal(t.updateSubs, 1, 'one UPDATE subscription');
  assert.equal(t.activitySubs, 1, 'one activity predicate');

  // Drive to (near) the target so we have a concrete settled value to freeze.
  c.set(2);
  run(t, 300);
  assert.ok(Math.abs(c.value - 2) < 1e-2, `spring reached target while visible (value ${c.value})`);
  const frozen = c.value;

  // --- go offscreen ---
  io.emit(false);
  assert.equal(c.active, false, 'DEACTIVATES when offscreen');
  assert.equal(stim.attached, false, 'stimulus DETACHED offscreen');
  assert.equal(stim.detachCount, 1, 'detached exactly once');
  assert.equal(t.updateSubs, 0, 'UPDATE subscription unsubscribed');
  assert.equal(t.activitySubs, 0, 'activity predicate unsubscribed');

  // Advancing frames must NOT step the spring — even if the target changes,
  // because onUpdate is no longer on the loop.
  c.set(2.9); // would pull the spring upward IF it were still stepping
  run(t, 300, 5000);
  assert.equal(c.value, frozen, 'value frozen while offscreen (spring not stepped)');

  c.destroy();
});

test('R5 gate: re-entry reactivates on the SAME ticker and resumes stepping', () => {
  const t = spyTicker();
  const io = fakeIntersectionObserver();
  const stim = trackingStimulus();
  const c = createStretchController({
    trigger: 'custom',
    ticker: t,
    element: fakeElement,
    stimulus: stim,
    intersectionObserverFactory: io.factory,
    minStretchRatio: 1,
    maxStretchRatio: 3,
  });

  // visible → settle at 2 → offscreen (frozen) → change target while idle
  io.emit(true);
  c.set(2);
  run(t, 300);
  const settledAt2 = c.value;
  assert.ok(Math.abs(settledAt2 - 2) < 1e-2, 'settled near 2 while visible');

  io.emit(false);
  c.set(2.6); // new target queued while offscreen; must not move yet
  run(t, 120, 5000);
  assert.equal(c.value, settledAt2, 'stays frozen while offscreen');

  // --- re-enter viewport ---
  io.emit(true);
  assert.equal(c.active, true, 'REACTIVATES on re-entry');
  assert.equal(stim.attached, true, 'stimulus re-attached');
  assert.equal(stim.attachCount, 2, 're-attached (second attach), not leaked');
  assert.equal(stim.detachCount, 1, 'detached exactly once total');

  // Exactly ONE loop: subscriptions return to 1 each (not 2), on the same base ticker.
  assert.equal(t.updateSubs, 1, 'one UPDATE subscription after re-entry (no duplicate loop)');
  assert.equal(t.activitySubs, 1, 'one activity predicate after re-entry');
  assert.equal(io.factoryCount, 1, 'no new observer created on re-entry');

  // Stepping resumes on the same ticker: value climbs from the frozen point
  // toward the (updated) target 2.6.
  run(t, 10, 6000);
  const midway = c.value;
  assert.ok(midway > settledAt2 + 1e-4, `resumed stepping after re-entry (value ${midway})`);
  run(t, 400, 7000);
  assert.ok(Math.abs(c.value - 2.6) < 1e-2, `reaches updated target after re-entry (value ${c.value})`);

  c.destroy();
  assert.equal(t.updateSubs, 0, 'destroy tears the UPDATE subscription down');
  assert.equal(t.activitySubs, 0, 'destroy tears the activity predicate down');
  assert.equal(io.disconnectCount, 1, 'destroy disconnects the observer');
});

test('R5 gate: repeated offscreen/onscreen toggles never accumulate subscriptions', () => {
  const t = spyTicker();
  const io = fakeIntersectionObserver();
  const stim = trackingStimulus();
  const c = createStretchController({
    trigger: 'custom',
    ticker: t,
    element: fakeElement,
    stimulus: stim,
    intersectionObserverFactory: io.factory,
    maxStretchRatio: 3,
  });

  for (let i = 0; i < 5; i++) {
    io.emit(true);
    assert.equal(t.updateSubs, 1, `updateSubs stays 1 on cycle ${i}`);
    assert.equal(t.activitySubs, 1, `activitySubs stays 1 on cycle ${i}`);
    io.emit(false);
    assert.equal(t.updateSubs, 0, `updateSubs back to 0 on cycle ${i}`);
    assert.equal(t.activitySubs, 0, `activitySubs back to 0 on cycle ${i}`);
  }
  // Idempotence: redundant same-state entries don't double-subscribe or detach twice.
  io.emit(true);
  io.emit(true);
  assert.equal(t.updateSubs, 1, 'redundant visible entry does not double-subscribe');
  assert.equal(stim.attachCount, 6, 'attach only ran on real transitions');

  c.destroy();
});
