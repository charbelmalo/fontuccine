/**
 * entries/webgl.ts — the `fontuccine/webgl` public entry (Tier 1, WebGL2 + MSDF).
 *
 * Renderer-only surface: the primary GPU tier (crisp at any ratio, post-fx
 * capable). Importing this subpath pulls the WebGL renderer + its MSDF/LUT
 * pipeline ONLY — never SVG or VF code. The shared-backend accessors are exported
 * so an app can pre-warm / ref-count the single page-global GL context.
 */
export { createWebglRenderer } from '../webgl/renderer.ts';
export type { WebglRenderer, WebglRendererOptions, StretchSource } from '../webgl/renderer.ts';
export type {
  WebglGlyph,
  EffectsConfig,
  AberrationConfig,
  DisplacementConfig,
  RGBAColor,
} from '../webgl/types.ts';
export { detectWebGL2 } from '../webgl/gl/capability.ts';
export type { WebGL2Support } from '../webgl/gl/capability.ts';
export {
  acquireSharedBackend,
  releaseSharedBackend,
  setBackendFactory,
  DEFAULT_GRID_SLICES,
} from '../webgl/gl/shared.ts';
