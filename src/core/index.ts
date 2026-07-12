/**
 * src/core/index.ts — INTERNAL barrel for the analysis core.
 *
 * This is NOT a public package entry point. Later tiers import it via relative
 * path; packaging (Phase 5) owns any public `exports` map.
 */
export type {
  PathCommand,
  Axis,
  BoundarySample,
  SampledOutline,
  BBox,
  Bounds1D,
  FlexLUT,
  Remap,
  AxisProfile,
  GlyphAnalysis,
  AnalyzeParams,
  AnalyzeRequest,
  AnalyzeResponse,
} from './types.ts';
export { DEFAULT_PARAMS } from './types.ts';

export { evalSegment, commandsToContours, splitSegment } from './geometry/segments.ts';
export type { Segment, Point, PointTangent } from './geometry/segments.ts';

export { sampleOutline, sampleBounds } from './sampling/outline.ts';
export { pointInGlyph } from './sampling/point-in-glyph.ts';

export { windingNumber, pointInside, filterVisibleSamples, WindingIndex } from './winding.ts';
export { KDTree } from './spatial/kdtree.ts';

export { computeFlexProfile, buildFlexField } from './flex-profile.ts';
export type { FlexProfileOptions, FlexField, FieldOptions } from './flex-profile.ts';

export { buildRemap, assertLUT } from './lut.ts';
export type { BuildRemapOptions } from './lut.ts';

export { layoutRun } from './kerning.ts';
export type {
  LayoutGlyph,
  LayoutGlyphResult,
  LayoutRunOptions,
  LayoutRunResult,
} from './kerning.ts';
