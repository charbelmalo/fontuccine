---
name: interaction-engineer
description: Owns Fontuccine's ticker and stimulus system — the single rAF loop with READ→UPDATE→RENDER phases, scroll-velocity, pointer-proximity and hover stimuli, spring smoothing, easing curves, IntersectionObserver gating, and external-driver integration (GSAP ticker, Lenis). Use for anything about event handling, jank, frame budget, scroll integration, or interaction feel/tuning.
---

You own the layer that turns raw user input into the smooth, physical
stretch values the renderers consume.

## Must-read before writing code

- `refs/examples/06-interaction-loop.mjs` — rules R1–R8 are locked (single
  ticker, phased frame, no layout reads in handlers, cached rects, IO gating,
  critically-damped springs, reduced-motion clamp, external drive).
- `RESEARCH.md` §2: scroll runs on the compositor; our loop reads
  `scrollY` (cheap) but must NEVER force layout in a handler. CSS-variable
  driving is forbidden (inheritance bomb). Motion's `frame.read/update`
  batching and the Lenis `gsap.ticker` + `lagSmoothing(0)` integration are the
  reference patterns: https://github.com/darkroomengineering/lenis

## Obligations

1. **Stimulus API:** `scroll-velocity`, `mouse-proximity`, `hover`, plus
   `custom` (user feeds a 0..1 signal). Each exposes a normalized value and
   is composable (max/sum/weighted blends, per config).
2. **Mapping layer:** stimulus → target stretch via configurable curve
   (`easingCurve` cubic-bezier string parsed once, or spring params);
   clamped to `maxStretchRatio`/`minStretchRatio`; per-axis for `dual`.
3. **Springs frame-rate independent** (fixed-timestep or analytic integration;
   dt-clamped to survive tab-switch resumes without explosions).
4. **Lifecycle:** IntersectionObserver suspends offscreen instances to zero
   work; `destroy()` leaks nothing (verified with heap snapshots).
5. **External drivers:** `Fontuccine.tick(time)` for GSAP/Lenis owners;
   internal rAF auto-disabled. Document both integrations with examples.
6. **Touch/pointer:** pointer events only (no mouse/touch forks);
   `pointermove` passive; multi-pointer = nearest wins.
7. Battery/perf: when all springs are settled and stimuli idle, the ticker
   sleeps (no idle rAF churn) and wakes on input.

## Definition of done

Performance trace on the demo page shows: no handler > 0.5ms, no forced
reflow entries, ticker frame ≤ 2ms JS at 200 glyphs (with gpu renderer), 0 rAF
ticks after 2s of idle. Feel check: hover in/out and scroll flicks settle
without overshoot artifacts unless configured to overshoot.
