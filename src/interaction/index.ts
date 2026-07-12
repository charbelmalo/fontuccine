/**
 * src/interaction/index.ts — INTERNAL barrel for the Phase-2 interaction layer.
 *
 * Composable primitives: one shared ticker (READ→UPDATE→RENDER), scroll /
 * proximity / hover stimuli, a critically-damped spring (or cubic-bezier
 * smoother), visibility gating, reduced-motion detection, and the
 * StretchController that composes them into a per-frame stretch scalar.
 *
 * This is NOT the public package entry point and does NOT contain
 * `Fontuccine.attach` or any renderer — that is Phase 5 packaging. Renderer
 * tiers subscribe to `ticker.render(...)` and read `controller.value`.
 */

// ticker
export { ticker, createTicker } from './ticker.ts';
export type { Ticker, FrameScheduler, FrameCallback, Phase, ActivityPredicate } from './ticker.ts';

// spring + smoother interface
export { createSpring } from './spring.ts';
export type { Spring, SpringOptions, Smoother } from './spring.ts';

// easing (cubic-bezier alternative to physics)
export { parseCubicBezier, cubicBezier, createBezierSmoother } from './easing.ts';
export type { EasingFn, BezierSmootherOptions } from './easing.ts';

// reduced motion
export { prefersReducedMotion, onReducedMotionChange } from './reduced-motion.ts';

// gating
export { observeVisibility } from './gating.ts';
export type {
  VisibilityOptions,
  IntersectionObserverLike,
  IntersectionEntryLike,
} from './gating.ts';

// stimuli
export { createScrollVelocityStimulus } from './stimuli/scroll-velocity.ts';
export type { ScrollVelocityOptions } from './stimuli/scroll-velocity.ts';
export { createProximityStimulus } from './stimuli/proximity.ts';
export type { ProximityOptions } from './stimuli/proximity.ts';
export { createHoverStimulus } from './stimuli/hover.ts';
export type { HoverOptions } from './stimuli/hover.ts';
export type { Stimulus, RectSource, Disposable, NowMs } from './stimuli/types.ts';

// controller
export { createStretchController } from './stretch-controller.ts';
export type {
  StretchController,
  StretchControllerConfig,
  Trigger,
  StretchAxis,
} from './stretch-controller.ts';
