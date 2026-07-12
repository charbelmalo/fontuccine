/**
 * interaction-ticker.test.ts — the single shared ticker (R1, R2, R8, sleep).
 *
 * Deterministic: a manual scheduler + directly-invoked `frame(now)` mean these
 * run with NO real rAF (Node has none).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTicker } from '../src/interaction/ticker.ts';
import type { FrameScheduler } from '../src/interaction/ticker.ts';

/** Scheduler that never auto-loops; frames are driven manually via ticker.frame. */
function inertScheduler(): FrameScheduler {
  return { requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 };
}

/** Scheduler that holds one pending callback so we can observe scheduling/sleep. */
function pumpScheduler() {
  let pending: ((now: number) => void) | null = null;
  const sched: FrameScheduler = {
    requestFrame(cb) {
      pending = cb;
      return 1;
    },
    cancelFrame() {
      pending = null;
    },
    now: () => 0,
  };
  return {
    sched,
    get scheduled() {
      return pending !== null;
    },
    /** Run the pending frame (if any). Returns whether one ran. */
    tick(now: number): boolean {
      const cb = pending;
      pending = null;
      if (cb) cb(now);
      return !!cb;
    },
  };
}

test('R2: phases run READ → UPDATE → RENDER within one frame', () => {
  const t = createTicker(inertScheduler());
  const order: string[] = [];
  t.read(() => order.push('read'));
  t.update(() => order.push('update'));
  t.render(() => order.push('render'));
  t.read(() => order.push('read2'));

  t.frame(0);

  // both reads before the update before the render
  assert.deepEqual(order, ['read', 'read2', 'update', 'render']);
});

test('R1: multiple subscribers share ONE loop (one frame advances all)', () => {
  const t = createTicker(inertScheduler());
  let a = 0;
  let b = 0;
  let r = 0;
  t.update(() => (a += 1));
  t.update(() => (b += 1));
  t.render(() => (r += 1));

  t.frame(0);
  t.frame(16);

  assert.equal(a, 2);
  assert.equal(b, 2);
  assert.equal(r, 2);
});

test('unsubscribe removes a phase callback', () => {
  const t = createTicker(inertScheduler());
  let n = 0;
  const off = t.update(() => (n += 1));
  t.frame(0);
  off();
  t.frame(16);
  assert.equal(n, 1);
});

test('battery: loop sleeps when no activity is live and wakes on input', () => {
  const pump = pumpScheduler();
  const t = createTicker(pump.sched);
  let live = true;
  t.onActivity(() => live);
  t.update(() => {});
  // subscribing started the loop → a frame is scheduled
  assert.ok(pump.scheduled, 'scheduled after first subscription');

  // while live, each frame reschedules the next
  pump.tick(0);
  assert.ok(pump.scheduled, 'reschedules while live');
  pump.tick(16);
  assert.ok(pump.scheduled, 'still rescheduling');

  // goes idle → the next frame does NOT reschedule (sleep)
  live = false;
  pump.tick(32);
  assert.ok(!pump.scheduled, 'sleeps when idle');
  assert.ok(!t.awake, 'not awake while asleep');

  // input wakes it
  t.wake();
  assert.ok(pump.scheduled, 'wake reschedules');
});

test('no activity predicate ⇒ loop stays on (back-compat)', () => {
  const pump = pumpScheduler();
  const t = createTicker(pump.sched);
  t.render(() => {});
  assert.ok(pump.scheduled);
  pump.tick(0);
  assert.ok(pump.scheduled, 'keeps running with no liveness info');
});

test('R8: drive() disables internal rAF and hands out the frame fn', () => {
  const pump = pumpScheduler();
  const t = createTicker(pump.sched);
  let updates = 0;
  t.update(() => (updates += 1));

  const tick = t.drive();
  assert.ok(t.external, 'external mode');
  assert.ok(!pump.scheduled, 'internal rAF cancelled under external drive');

  // external owner drives the loop
  tick(0);
  tick(16);
  assert.equal(updates, 2);
  assert.ok(!pump.scheduled, 'never schedules its own rAF while driven');

  // wake is a no-op under external drive
  t.wake();
  assert.ok(!pump.scheduled);

  // undrive restores the internal loop
  t.undrive();
  assert.ok(!t.external);
  assert.ok(pump.scheduled, 'internal loop resumes after undrive');
});

test('stop() halts the loop and cancels the pending frame', () => {
  const pump = pumpScheduler();
  const t = createTicker(pump.sched);
  t.update(() => {});
  assert.ok(pump.scheduled);
  t.stop();
  assert.ok(!pump.scheduled, 'pending frame cancelled');
  assert.ok(!t.running);
});

test('full teardown ⇒ loop fully stops (0 pending rAF, not running)', () => {
  const pump = pumpScheduler();
  const t = createTicker(pump.sched);
  // Simulate an attached instance the way a StretchController does: an UPDATE
  // phase plus a liveness predicate `() => !settled`.
  let settled = false;
  const offUpdate = t.update(() => {});
  const offActivity = t.onActivity(() => !settled);
  assert.ok(pump.scheduled, 'scheduled while attached');

  // Live (not settled) ⇒ each frame reschedules the next.
  pump.tick(0);
  assert.ok(pump.scheduled, 'reschedules while live');

  // FULL TEARDOWN: the instance is destroyed — BOTH its phase and its liveness
  // predicate are removed (nothing left registered, nothing driving).
  offUpdate();
  offActivity();

  // The already-pending frame runs, finds nothing registered, and must NOT
  // reschedule. (Against the old `activity.size === 0 ⇒ true` back-compat
  // branch this asserted `pump.scheduled` and looped forever — that is the bug.)
  pump.tick(16);
  assert.ok(!pump.scheduled, '0 pending rAF after full teardown');
  assert.ok(!t.awake, 'not awake after teardown');
  assert.ok(!t.running, 'loop fully stopped (not running) after teardown');
});

test('re-attach after full teardown restarts the loop', () => {
  const pump = pumpScheduler();
  const t = createTicker(pump.sched);
  const offUpdate = t.update(() => {});
  const offActivity = t.onActivity(() => false); // already settled
  offUpdate();
  offActivity();
  pump.tick(0); // pending frame runs into full-teardown stop
  assert.ok(!pump.scheduled, 'stopped: 0 pending rAF after teardown');
  assert.ok(!t.running, 'not running after teardown');

  // A fresh attach (new phase + new liveness predicate) must restart cleanly.
  let settled = false;
  t.update(() => {});
  t.onActivity(() => !settled);
  assert.ok(pump.scheduled, 're-attach reschedules a frame');
  assert.ok(t.running, 'running again after re-attach');

  // And it actually loops while live.
  pump.tick(16);
  assert.ok(pump.scheduled, 'keeps running after re-attach');
});

test('settle self-park is intact: attached-but-settled parks (NOT stop) and resumes', () => {
  const pump = pumpScheduler();
  const t = createTicker(pump.sched);
  let settled = false;
  t.update(() => {});
  // StretchController guarantee: the predicate stays REGISTERED even once
  // settled; parking is decided by it returning false, not by removing it.
  t.onActivity(() => !settled);
  assert.ok(pump.scheduled, 'scheduled while attached + live');

  // The spring settles but the instance stays ATTACHED (predicate not removed).
  settled = true;
  pump.tick(0);
  assert.ok(!pump.scheduled, 'parks (loop idles) when settled');
  assert.ok(!t.awake, 'not awake while parked');
  // Crucial: parking is NOT teardown — the loop stays RUNNING, ready to wake.
  assert.ok(t.running, 'still running while parked (attached, not torn down)');

  // New activity flips the predicate live again; wake() resumes the loop.
  settled = false;
  t.wake();
  assert.ok(pump.scheduled, 'resumes on wake when predicate is live again');
  pump.tick(16);
  assert.ok(pump.scheduled, 'keeps running while live again');
});
