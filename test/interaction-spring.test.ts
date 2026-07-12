/**
 * interaction-spring.test.ts — critically-damped spring (R6).
 *
 * Frame-rate independent (analytic integration), no overshoot at default
 * (critical) damping, dt-clamped so a huge resume dt cannot explode.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpring } from '../src/interaction/spring.ts';

test('critically damped: converges to target with NO overshoot', () => {
  const s = createSpring({ stiffness: 170, initial: 0 }); // damping omitted ⇒ critical
  s.set(2);
  let maxSeen = -Infinity;
  for (let i = 0; i < 1200; i++) {
    s.step(1 / 60);
    maxSeen = Math.max(maxSeen, s.value);
  }
  assert.ok(maxSeen <= 2 + 1e-9, `no overshoot (max ${maxSeen})`);
  assert.ok(Math.abs(s.value - 2) < 1e-3, `converged (value ${s.value})`);
  assert.ok(s.settled, 'reports settled');
});

test('frame-rate independent: large vs small steps reach the same place', () => {
  const fine = createSpring({ stiffness: 120, initial: 1 });
  const coarse = createSpring({ stiffness: 120, initial: 1 });
  fine.set(3);
  coarse.set(3);
  // 1 second of simulation, different step sizes.
  for (let i = 0; i < 240; i++) fine.step(1 / 240);
  for (let i = 0; i < 60; i++) coarse.step(1 / 60);
  assert.ok(Math.abs(fine.value - coarse.value) < 1e-2, `dt-independent (${fine.value} vs ${coarse.value})`);
});

test('dt-clamp: a huge resume dt does not explode', () => {
  const s = createSpring({ stiffness: 170, initial: 0 });
  s.set(2);
  s.step(1000); // tab was backgrounded for ~16 minutes
  assert.ok(Number.isFinite(s.value), 'value finite after huge dt');
  assert.ok(s.value <= 2 + 1e-9 && s.value >= 0, `bounded (${s.value})`);
  // continues to converge normally afterward
  for (let i = 0; i < 600; i++) s.step(1 / 60);
  assert.ok(Math.abs(s.value - 2) < 1e-3);
});

test('underdamped overshoots (intentional, when configured)', () => {
  const s = createSpring({ stiffness: 170, damping: 6, initial: 0 });
  s.set(1);
  let maxSeen = -Infinity;
  for (let i = 0; i < 600; i++) {
    s.step(1 / 60);
    maxSeen = Math.max(maxSeen, s.value);
  }
  assert.ok(maxSeen > 1 + 1e-3, `overshoots past target (max ${maxSeen})`);
});

test('snap sets value+target instantly and is settled', () => {
  const s = createSpring({ initial: 0 });
  s.snap(1.5);
  assert.equal(s.value, 1.5);
  assert.ok(s.settled);
});
