/**
 * src/svg/index.ts — INTERNAL barrel for the Tier-2 (SVG path remap) renderer.
 *
 * NOT a public package entry point. There is deliberately no `fontuccine/svg`
 * export yet — packaging (Phase 5) owns the `exports` map. Consumers inside the
 * repo import from here via relative path.
 */

// renderer
export { createSvgRenderer } from './renderer.ts';
export type { SvgRenderer, SvgRendererOptions, SvgGlyph, StretchSource } from './renderer.ts';

// pure geometry (STATIC split + PER-FRAME exact remap/serialize)
export {
  splitGlyph,
  interiorBoundaries,
  remapContours,
  contoursToPathData,
  serializeGlyph,
} from './split.ts';
export type { SplitContour } from './split.ts';

// shared a11y/SEO overlay (owned here, consumed by every tier)
export { createOverlay } from '../dom/overlay.ts';
export type { Overlay, OverlayOptions, WrapMode } from '../dom/overlay.ts';
