/**
 * webgl/index.ts — Tier 1 (WebGL2 + runtime MSDF atlas) internal barrel.
 *
 * INTERNAL surface. Nothing here is re-exported from the package root — the
 * engine selects this tier behind the shared renderer interface; the public API
 * (README.md) is unchanged (CLAUDE.md: no public export, no schema change).
 *
 * A future WebGPU/WGSL backend slots in behind the SAME seams (`RenderBackend`
 * + the cumulative-flex LUT contract), so callers of `createWebglRenderer` never
 * learn which GPU API rendered the frame.
 */

// Orchestration (matches the cross-tier renderer interface).
export { createWebglRenderer } from './renderer.ts';
export type { WebglRenderer, WebglRendererOptions, StretchSource } from './renderer.ts';

// Config + glyph input surface (mirrors README `effects`, no schema fork).
export type {
  WebglGlyph,
  EffectsConfig,
  AberrationConfig,
  DisplacementConfig,
  RGBAColor,
} from './types.ts';

// Capability probe (obligation 4: engine drops to SVG when unsupported).
export { detectWebGL2 } from './gl/capability.ts';
export type { WebGL2Support } from './gl/capability.ts';

// Shared single-context backend (RESEARCH §2 layer-memory discipline).
export {
  acquireSharedBackend,
  releaseSharedBackend,
  setBackendFactory,
  __resetSharedBackend,
  DEFAULT_GRID_SLICES,
} from './gl/shared.ts';
export type { BackendFactory } from './gl/shared.ts';
export type {
  RenderBackend,
  RunHandle,
  GlyphRunData,
  FrameParams,
  Region,
} from './gl/device.ts';
export { WebGL2Backend } from './gl/device.ts';

// Runtime MSDF pipeline (worker-generated; never per frame / never main thread).
export { MsdfClient } from './msdf/client.ts';
export type { MsdfGlyphInput, MsdfClientOptions } from './msdf/client.ts';
export { generateMSDF, colorEdges, median3 } from './msdf/generator.ts';
export type { MSDFBitmap, MSDFOptions, ColoredEdge } from './msdf/generator.ts';
export { MsdfAtlas } from './msdf/atlas.ts';
export type { AtlasEntry } from './msdf/atlas.ts';
export { handleMsdfRequest } from './msdf/worker.ts';
export type { MsdfRequest, MsdfResponse } from './msdf/worker.ts';

// Static geometry / LUT-packing primitives (pure; Node-testable without GL).
export { buildFlexCumulative, sampleNormalizedLUT, gpuRemapX, glyphOriginFactor } from './parity.ts';
export { packLUTAtlas, unpackLUTRow, lutRowCoord } from './lut-texture.ts';
export type { PackedLUTAtlas } from './lut-texture.ts';
export { buildSliceGrid } from './slice-grid.ts';
export type { SliceGrid } from './slice-grid.ts';

// Shader sources (inspection / reuse by a future WGSL transpile step).
export { VERTEX_SHADER, FRAGMENT_SHADER } from './gl/shaders.ts';
