/**
 * src/vf/index.ts — INTERNAL barrel for the Tier-0 (variable-font `wdth`) tier.
 *
 * NOT a public package entry point. There is deliberately no `fontuccine/vf`
 * export yet — packaging (Phase 5) owns the `exports` map. Consumers inside the
 * repo import from here via relative path.
 */

// detection (pure, Node-testable)
export { getWdthAxis, hasWdthAxis } from './detect.ts';
export type { WdthAxis, FvarAxisRecord, FvarBearingFont } from './detect.ts';

// capability probe + stretch→wdth mapping (pure)
export {
  probeTier0,
  createWdthMapping,
  cssSupportsFontStretchPercentage,
} from './probe.ts';
export type {
  Tier0Decision,
  Tier0DeclineReason,
  StretchRangeConfig,
  WdthMapping,
} from './probe.ts';

// renderer (Tier 0 — real text stays; no a11y overlay)
export { createVfRenderer } from './renderer.ts';
export type {
  VfRenderer,
  VfRendererOptions,
  WdthApplyMode,
  StretchSource,
} from './renderer.ts';
