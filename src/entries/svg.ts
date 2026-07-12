/**
 * entries/svg.ts — the `fontuccine/svg` public entry (Tier 2, SVG path remap).
 *
 * Renderer-only surface: the exact-vector fallback/fidelity tier. Importing this
 * subpath pulls the SVG renderer + core geometry ONLY — never WebGL or VF code
 * (verified by bundle inspection in the Phase-5 build). Advanced users who want
 * the full ergonomic pipeline (font load + auto tier dispatch) import the `.`
 * entry (`fontuccine`) instead.
 */
export { createSvgRenderer } from '../svg/renderer.ts';
export type {
  SvgRenderer,
  SvgRendererOptions,
  SvgGlyph,
  StretchSource,
} from '../svg/renderer.ts';
export { createOverlay } from '../dom/overlay.ts';
export type { Overlay, OverlayOptions, WrapMode, ReserveBasis } from '../dom/overlay.ts';
