/**
 * entries/vf.ts — the `fontuccine/vf` public entry (Tier 0, variable-font wdth).
 *
 * Renderer-only surface: the opportunistic cheap/high-typographic-quality tier.
 * D-tier per-frame cost (main-thread layout+paint) — never the perf headline
 * (CLAUDE.md rule 5). Importing this subpath pulls the VF renderer + detection/
 * probe ONLY — never WebGL or SVG code.
 */
export { createVfRenderer } from '../vf/renderer.ts';
export type {
  VfRenderer,
  VfRendererOptions,
  WdthApplyMode,
  StretchSource,
} from '../vf/renderer.ts';
export { getWdthAxis, hasWdthAxis } from '../vf/detect.ts';
export type { WdthAxis, FvarAxisRecord, FvarBearingFont } from '../vf/detect.ts';
export {
  probeTier0,
  createWdthMapping,
  cssSupportsFontStretchPercentage,
} from '../vf/probe.ts';
export type {
  Tier0Decision,
  Tier0DeclineReason,
  StretchRangeConfig,
  WdthMapping,
} from '../vf/probe.ts';
