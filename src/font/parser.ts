/**
 * font/parser.ts — font parsing behind a swappable interface.
 *
 * opentype.js is the default backend; the FontParser / ParsedFont interfaces
 * let Typr or harfbuzzjs drop in later without touching the analysis core.
 *
 * System-font / CSS-only fallback strategy:
 *   The analysis core needs an outline binary. When no font binary is
 *   obtainable (e.g. a CSS-only web font whose bytes the page can't read),
 *   there is nothing to analyze. Callers should catch FontUnavailableError and
 *   signal TIER DEGRADATION to the renderer layer (rasterize via canvas — the
 *   architect owns that decision). The core NEVER crashes the pipeline for it.
 */
import opentype from 'opentype.js';
import type { Font as OtFont, Glyph as OtGlyph, GlyfPoint as OtPoint, GlyfComponent as OtComponent, Path as OtPath } from 'opentype.js';
import type { PathCommand, BBox } from '../core/types.ts';
import { createInstancer } from './variation.ts';
import type { Instancer, Pt } from './variation.ts';

export interface ParsedGlyph {
  commands: PathCommand[];
  advanceWidth: number;
  bbox: BBox;
}

/** How a variation request was honoured by the parser. */
export interface VariationStatus {
  /** The axes the caller asked for (user space, e.g. `{ wght: 700 }`). */
  requested: Record<string, number>;
  /** True when outlines are instanced at `location` (false ⇒ default instance). */
  applied: boolean;
  /** The location actually used (clamped to the designed ranges) when applied. */
  location?: Record<string, number>;
  /** Why the default instance is rendered instead (when not applied). */
  reason?: 'not-variable' | 'no-gvar' | 'cff2-unsupported' | 'unsupported-container' | 'default-location';
}

export interface ParsedFont {
  /** Glyph for a single character, or null if unmapped/blank. */
  glyph(char: string): ParsedGlyph | null;
  /** Kerning between two characters, in the same units as glyph commands. */
  kernPair(a: string, b: string): number;
  /** Advance for ANY mapped char (blanks included), in glyph units; 0 if unmapped. */
  advance?(char: string): number;
  /** Coordinate scale used for emitted commands (= fontSize). */
  unitsPerEm: number;
  name?: string;
  /** Present when a `variations` request was passed to the parser. */
  variation?: VariationStatus;
}

export interface ParseOptions {
  fontSize?: number;
  /**
   * Variable-font instance to render, in user axis units (`{ wght: 700,
   * wdth: 100, opsz: 128 }`). Axes the font lacks are ignored; a static font
   * renders unchanged. See `variation.ts` for the supported table set.
   */
  variations?: Record<string, number>;
}

export interface FontParser {
  parse(buffer: ArrayBuffer, opts?: ParseOptions): ParsedFont;
}

/** Raised when no font binary is available — signals tier degradation. */
export class FontUnavailableError extends Error {
  constructor(message = 'No font binary available for analysis') {
    super(message);
    this.name = 'FontUnavailableError';
  }
}

/**
 * opentype.js-backed parser. Commands are emitted in SVG-down coordinates at
 * `fontSize` units-per-em (default 1000), matching 08-real-font-demo.mjs.
 */
export class OpentypeParser implements FontParser {
  parse(buffer: ArrayBuffer, opts: ParseOptions = {}): ParsedFont {
    const font = openOt(buffer);
    const fontSize = opts.fontSize ?? 1000;

    // Variable-font instancing (gvar deltas on the raw TrueType points).
    let instancer: Instancer | null = null;
    let variation: VariationStatus | undefined;
    if (opts.variations) {
      const r = createInstancer(buffer, opts.variations);
      if (r.ok && r.instancer.active) {
        instancer = r.instancer;
        variation = { requested: opts.variations, applied: true, location: r.instancer.location };
      } else {
        variation = {
          requested: opts.variations,
          applied: false,
          reason: r.ok ? 'default-location' : r.reason,
        };
      }
    }
    return makeParsed(font, fontSize, instancer, variation);
  }
}

function openOt(buffer: ArrayBuffer): OtFont {
  if (!buffer || buffer.byteLength === 0) {
    throw new FontUnavailableError('Empty font buffer');
  }
  try {
    return opentype.parse(buffer);
  } catch (err) {
    throw new FontUnavailableError(`opentype.js failed to parse font: ${String(err)}`);
  }
}

/**
 * A ParsedFont over an already-parsed opentype.js Font. With an instancer the
 * outlines ALWAYS go through the gvar point path (even at the default
 * location), so every instance of the same glyph has the same command list —
 * the property width-plan.ts relies on to blend instances point by point.
 */
function makeParsed(font: OtFont, fontSize: number, instancer: Instancer | null, variation?: VariationStatus): ParsedFont {
  const scale = fontSize / font.unitsPerEm;
  const cache = new Map<string, { points: OtPoint[]; advance: number } | null>();
  const instanced = (char: string) => {
    let hit = cache.get(char);
    if (hit === undefined) {
      const g = font.charToGlyph(char);
      hit = g ? instancedPoints(font, g, instancer!, new Set()) : null;
      cache.set(char, hit);
    }
    return hit;
  };

  return {
    unitsPerEm: fontSize,
    name: font.names?.fullName?.en,
    ...(variation ? { variation } : {}),
    glyph(char: string): ParsedGlyph | null {
      const g = font.charToGlyph(char);
      if (!g) return null;
      if (instancer) {
        const inst = instanced(char);
        if (!inst) return null;
        const path = pathFromPoints(inst.points, scale);
        if (path.commands.length === 0) return null;
        const bb = path.getBoundingBox();
        return {
          commands: path.commands as PathCommand[],
          advanceWidth: inst.advance * scale,
          bbox: { minX: bb.x1, minY: bb.y1, maxX: bb.x2, maxY: bb.y2 },
        };
      }
      const path = g.getPath(0, 0, fontSize);
      if (!path.commands || path.commands.length === 0) return null;
      // Path bbox is already at fontSize scale and in SVG-down space,
      // matching the emitted commands.
      const bb = path.getBoundingBox();
      return {
        commands: path.commands as PathCommand[],
        advanceWidth: (g.advanceWidth ?? 0) * scale,
        bbox: { minX: bb.x1, minY: bb.y1, maxX: bb.x2, maxY: bb.y2 },
      };
    },
    advance(char: string): number {
      const g = font.charToGlyph(char);
      if (!g) return 0;
      if (instancer) return (instanced(char)?.advance ?? 0) * scale;
      return (g.advanceWidth ?? 0) * scale;
    },
    kernPair(a: string, b: string): number {
      const ga = font.charToGlyph(a);
      const gb = font.charToGlyph(b);
      if (!ga || !gb) return 0;
      return (font.getKerningValue(ga, gb) || 0) * scale;
    },
  };
}

/** One parse, many instances (see openVariableFont). */
export interface VariableFontHandle {
  /** The font's fvar axes (user-space ranges). */
  readonly axes: ReadonlyArray<{ tag: string; min: number; default: number; max: number }>;
  /**
   * The font at a user-space location (missing axes take their default,
   * values clamp to the designed range). Outlines always come from the gvar
   * point path, so all instances share one command structure per glyph.
   */
  at(location: Readonly<Record<string, number>>): ParsedFont;
}

/**
 * Open a TrueType-flavoured variable font once and instance it at any number
 * of locations (the width ladder needs a few dozen). Null when the font cannot
 * be instanced (static, CFF2, no gvar) — callers then have no width axis.
 */
export function openVariableFont(buffer: ArrayBuffer, opts: { fontSize?: number } = {}): VariableFontHandle | null {
  const probe = createInstancer(buffer, {});
  if (!probe.ok) return null;
  const font = openOt(buffer);
  const fontSize = opts.fontSize ?? 1000;
  return {
    axes: probe.instancer.axes,
    at(location) {
      const r = createInstancer(buffer, location);
      if (!r.ok) throw new FontUnavailableError(`variable font instancing failed (${r.reason})`);
      return makeParsed(font, fontSize, r.instancer, {
        requested: { ...location },
        applied: true,
        location: r.instancer.location,
      });
    },
  };
}

/** Convenience factory: parse a buffer with the default (opentype.js) backend. */
export function parseFont(buffer: ArrayBuffer, opts?: ParseOptions): ParsedFont {
  return new OpentypeParser().parse(buffer, opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Instanced TrueType outlines (opentype.js keeps the raw `glyf` points on each
// glyph; we move them by the gvar deltas and rebuild the quadratic path with
// the same on/off-curve rules opentype.js uses, so the default instance and an
// instanced one go through identical geometry).
// ─────────────────────────────────────────────────────────────────────────────


function transformPoints(points: OtPoint[], t: Omit<OtComponent, 'glyphIndex' | 'matchedPoints'>): OtPoint[] {
  return points.map((p) => ({
    x: t.xScale * p.x + t.scale01 * p.y + t.dx,
    y: t.scale10 * p.x + t.yScale * p.y + t.dy,
    onCurve: p.onCurve,
    lastPointOfContour: p.lastPointOfContour,
  }));
}

function instancedPoints(
  font: OtFont,
  glyph: OtGlyph,
  instancer: Instancer,
  visiting: Set<number>,
): { points: OtPoint[]; advance: number } {
  void glyph.path; // forces opentype.js to parse the glyf record (points/components)
  const baseAdvance = glyph.advanceWidth ?? 0;
  if (glyph.isComposite && glyph.components) {
    if (visiting.has(glyph.index)) return { points: [], advance: baseAdvance }; // malformed cycle
    visiting.add(glyph.index);
    const comps = glyph.components;
    const d = instancer.deltas(
      glyph.index,
      comps.map((c) => ({ x: c.dx, y: c.dy })),
      comps.map((_, i) => i),
    );
    let pts: OtPoint[] = [];
    comps.forEach((c, j) => {
      const sub = instancedPoints(font, font.glyphs.get(c.glyphIndex), instancer, visiting);
      const ddx = d ? d.dx[j]! : 0;
      const ddy = d ? d.dy[j]! : 0;
      let t = { xScale: c.xScale, scale01: c.scale01, scale10: c.scale10, yScale: c.yScale, dx: c.dx + ddx, dy: c.dy + ddy };
      if (c.matchedPoints !== undefined) {
        const first = pts[c.matchedPoints[0]];
        const second = sub.points[c.matchedPoints[1]];
        if (!first || !second) return;
        t = { ...t, dx: 0, dy: 0 };
        const s2 = transformPoints([second], t)[0]!;
        t.dx = first.x - s2.x;
        t.dy = first.y - s2.y;
      }
      pts = pts.concat(transformPoints(sub.points, t));
    });
    visiting.delete(glyph.index);
    const n = comps.length;
    return { points: pts, advance: baseAdvance + (d ? d.dx[n + 1]! - d.dx[n]! : 0) };
  }
  const src = glyph.points ?? [];
  const ends: number[] = [];
  src.forEach((p, i) => {
    if (p.lastPointOfContour) ends.push(i);
  });
  const d = instancer.deltas(glyph.index, src, ends);
  if (!d) return { points: src, advance: baseAdvance };
  const n = src.length;
  return {
    points: src.map((p, i) => ({ x: p.x + d.dx[i]!, y: p.y + d.dy[i]!, onCurve: p.onCurve, lastPointOfContour: p.lastPointOfContour })),
    advance: baseAdvance + (d.dx[n + 1]! - d.dx[n]!),
  };
}

/** TrueType points → opentype.js Path at `scale`, SVG-down (y flipped). */
function pathFromPoints(points: OtPoint[], scale: number): OtPath {
  const p = new opentype.Path();
  const contours: OtPoint[][] = [];
  let cur: OtPoint[] = [];
  for (const pt of points) {
    cur.push(pt);
    if (pt.lastPointOfContour) {
      contours.push(cur);
      cur = [];
    }
  }
  if (cur.length) contours.push(cur);
  const X = (x: number) => x * scale;
  const Y = (y: number) => -y * scale;
  for (const contour of contours) {
    if (contour.length === 0) continue;
    let curr: Pt & { onCurve: boolean } = contour[contour.length - 1]!;
    let next: Pt & { onCurve: boolean } = contour[0]!;
    if (curr.onCurve) p.moveTo(X(curr.x), Y(curr.y));
    else if (next.onCurve) p.moveTo(X(next.x), Y(next.y));
    else p.moveTo(X((curr.x + next.x) * 0.5), Y((curr.y + next.y) * 0.5));
    for (let i = 0; i < contour.length; i++) {
      curr = next;
      next = contour[(i + 1) % contour.length]!;
      if (curr.onCurve) {
        p.lineTo(X(curr.x), Y(curr.y));
      } else {
        // off-curve control; two consecutive off-curve points imply an
        // on-curve midpoint between them (TrueType quadratic rule)
        const end: Pt = next.onCurve ? next : { x: (curr.x + next.x) * 0.5, y: (curr.y + next.y) * 0.5 };
        p.quadraticCurveTo(X(curr.x), Y(curr.y), X(end.x), Y(end.y));
      }
    }
    p.closePath();
  }
  return p;
}
