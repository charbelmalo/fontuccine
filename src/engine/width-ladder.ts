/**
 * engine/width-ladder.ts — build the WidthPlan (core/width-plan.ts) for a run:
 * the font's own wider (and narrower) designs, instanced with the in-house gvar
 * instancer, sorted by run width.
 *
 * Path through the design space, from the requested (resting) location:
 *   up:   wdth → its max, then XTRA → its max (wdth held at max);
 *   down: wdth → its min, then XTRA → its min (wdth held at min).
 * Axes the font lacks are skipped; a font with neither yields a one-step plan
 * (residual only), exactly like a static font.
 *
 * Steps are placed ADAPTIVELY along each segment by bisection, so the linear
 * blend of neighbouring steps stays within `tolerance` font units of the true
 * instance everywhere (gvar is piecewise linear in the normalized coordinate,
 * and avar bends the user→normalized map, so a segment can have interior
 * breakpoints). A second criterion bounds how far any outline point moves
 * inside the glyph's normalized box between neighbours, in MSDF atlas texels:
 * the WebGL tier blends the two steps' distance fields at the same box
 * coordinate, which reproduces the outline blend only while edges move less
 * than the field's range.
 *
 * Only the steps the run can reach in [minStretch, maxStretch] are kept (plus
 * the first one past each end). Straight-column weights are analysed for the
 * two END steps only — the residual stage never runs on an interior step.
 */
import type { AnalysisClient } from '../worker/client.ts';
import type { AnalyzeParams, PathCommand, BBox } from '../core/types.ts';
import type { ParsedFont, VariableFontHandle } from '../font/parser.ts';
import type { PlanGlyph, WidthPlan, WidthStep } from '../core/width-plan.ts';
import { runWidth, singleStepPlan, defaultTracking } from '../core/width-plan.ts';
import type { RenderGlyph } from './glyphs.ts';

export interface WidthLadderOptions {
  /** One parse of the (sfnt) font binary, instanced per step. */
  font: VariableFontHandle;
  /** The resting design location (user space), e.g. `{ wght: 700, opsz: 120 }`. */
  base?: Record<string, number>;
  /** The run as built by engine/glyphs.ts at the resting location. */
  glyphs: RenderGlyph[];
  client: AnalysisClient;
  params: AnalyzeParams;
  unitsPerEm: number;
  minStretch: number;
  maxStretch: number;
  /** Max blend error vs the true instance, font units. Default upm / 500. */
  tolerance?: number;
  /** Max in-box point displacement between neighbouring steps, atlas texels. Default 1.5. */
  texelTolerance?: number;
  /** MSDF atlas resolution the texel bound refers to. Default 64 px / em. */
  atlasPxPerEm?: number;
  /** Bisection depth per segment. Default 5 (≤ 32 sub-steps). */
  maxDepth?: number;
  /** Per-gap tracking measure for the residual (width-plan.ts). Default upm / 10. */
  tracking?: number;
}

interface Inst {
  loc: Record<string, number>;
  key: string;
  glyphs: Array<{ commands: PathCommand[]; advanceWidth: number; bbox: BBox; flat: Float64Array }>;
  width: number;
}

const BLANK_BBOX: BBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

function flatten(cmds: PathCommand[]): Float64Array {
  let n = 0;
  for (const c of cmds) {
    if (c.x !== undefined) n += 2;
    if (c.x1 !== undefined) n += 2;
    if (c.x2 !== undefined) n += 2;
  }
  const out = new Float64Array(n);
  let i = 0;
  for (const c of cmds) {
    if (c.x1 !== undefined) {
      out[i++] = c.x1;
      out[i++] = c.y1 ?? 0;
    }
    if (c.x2 !== undefined) {
      out[i++] = c.x2;
      out[i++] = c.y2 ?? 0;
    }
    if (c.x !== undefined) {
      out[i++] = c.x;
      out[i++] = c.y ?? 0;
    }
  }
  return out;
}

function sameStructure(a: PathCommand[], b: PathCommand[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].type !== b[i].type) return false;
  return true;
}

function locKey(loc: Record<string, number>): string {
  return Object.keys(loc)
    .sort()
    .map((k) => `${k}=${Math.round(loc[k] * 1000) / 1000}`)
    .join(',');
}

/** Build the plan. Never throws for an unusable font: it degrades to one step. */
export async function buildWidthLadder(opts: WidthLadderOptions): Promise<WidthPlan> {
  const { font, glyphs: run, client, params, unitsPerEm } = opts;
  const tol = opts.tolerance ?? unitsPerEm / 500;
  const texTol = opts.texelTolerance ?? 1.5;
  const pxPerUnit = (opts.atlasPxPerEm ?? 64) / unitsPerEm;
  const maxDepth = opts.maxDepth ?? 5;
  const chars = run.map((g) => g.char);

  const axisOf = (tag: string) => font.axes.find((a) => a.tag === tag);
  const baseLoc: Record<string, number> = {};
  for (const a of font.axes) {
    const v = opts.base?.[a.tag];
    baseLoc[a.tag] = Math.min(a.max, Math.max(a.min, v != null && Number.isFinite(v) ? v : a.default));
  }

  const cache = new Map<string, Inst | null>();
  const instance = (loc: Record<string, number>): Inst | null => {
    const key = locKey(loc);
    if (cache.has(key)) return cache.get(key)!;
    let inst: Inst | null = null;
    try {
      const parsed: ParsedFont = font.at(loc);
      const gl: Inst['glyphs'] = [];
      for (let i = 0; i < run.length; i++) {
        const ch = chars[i];
        const g = run[i].commands.length > 0 ? parsed.glyph(ch) : null;
        if (run[i].commands.length > 0 && !g) throw new Error('glyph vanished');
        const advanceWidth = g ? g.advanceWidth : parsed.advance ? parsed.advance(ch) : run[i].advanceWidth;
        const commands = g ? g.commands : [];
        gl.push({ commands, advanceWidth, bbox: g ? g.bbox : BLANK_BBOX, flat: flatten(commands) });
      }
      let width = 0;
      for (let i = 0; i < run.length; i++) width += run[i].kernBefore + gl[i].advanceWidth;
      inst = { loc: { ...loc }, key, glyphs: gl, width };
    } catch {
      inst = null;
    }
    cache.set(key, inst);
    return inst;
  };

  const base = instance(baseLoc);
  if (!base) return fallback(opts);

  /** Max blend error of `mid` vs lerp(a, b, t) and in-box displacement a→b. */
  const needsSplit = (a: Inst, mid: Inst, b: Inst, t: number): boolean => {
    for (let gi = 0; gi < run.length; gi++) {
      const fa = a.glyphs[gi].flat;
      const fm = mid.glyphs[gi].flat;
      const fb = b.glyphs[gi].flat;
      if (fa.length !== fb.length || fa.length !== fm.length) return false; // handled by structure check
      for (let i = 0; i < fa.length; i++) {
        const e = fm[i] - (fa[i] + t * (fb[i] - fa[i]));
        if (Math.abs(e) > tol) return true;
      }
      const ba = a.glyphs[gi].bbox;
      const bb = b.glyphs[gi].bbox;
      const wa = ba.maxX - ba.minX;
      const wb = bb.maxX - bb.minX;
      const ha = ba.maxY - ba.minY;
      const hb = bb.maxY - bb.minY;
      if (!(wa > 0 && wb > 0 && ha > 0 && hb > 0)) continue;
      const wpx = Math.max(wa, wb) * pxPerUnit;
      const hpx = Math.max(ha, hb) * pxPerUnit;
      for (let i = 0; i < fa.length; i += 2) {
        const du = Math.abs((fa[i] - ba.minX) / wa - (fb[i] - bb.minX) / wb) * wpx;
        const dv = Math.abs((fa[i + 1] - ba.minY) / ha - (fb[i + 1] - bb.minY) / hb) * hpx;
        if (du > texTol || dv > texTol) return true;
      }
    }
    return false;
  };

  /** Instances along one straight segment of the path (excluding `from`). */
  const walk = (from: Record<string, number>, tag: string, to: number): Inst[] => {
    const at = (u: number) => ({ ...from, [tag]: from[tag] + u * (to - from[tag]) });
    const out: Inst[] = [];
    const rec = (u0: number, a: Inst, u1: number, b: Inst, depth: number): boolean => {
      const um = (u0 + u1) / 2;
      const m = depth < maxDepth ? instance(at(um)) : null;
      if (m && needsSplit(a, m, b, 0.5)) {
        if (!rec(u0, a, um, m, depth + 1)) return false;
        return rec(um, m, u1, b, depth + 1);
      }
      out.push(b);
      return true;
    };
    const a = instance(from);
    const b = instance(at(1));
    if (!a || !b) return out;
    rec(0, a, 1, b, 0);
    return out;
  };

  const target = { up: opts.maxStretch * base.width, down: opts.minStretch * base.width };
  const climb = (dir: 'up' | 'down'): Inst[] => {
    const steps: Inst[] = [];
    let loc = { ...baseLoc };
    for (const tag of ['wdth', 'XTRA']) {
      const ax = axisOf(tag);
      if (!ax) continue;
      const end = dir === 'up' ? ax.max : ax.min;
      if (Math.abs(end - loc[tag]) < 1e-9) continue;
      for (const s of walk(loc, tag, end)) {
        const prev = steps.length ? steps[steps.length - 1].width : base.width;
        // keep the ladder strictly monotonic in run width
        if (dir === 'up' ? s.width <= prev + 1e-6 : s.width >= prev - 1e-6) continue;
        steps.push(s);
        if (dir === 'up' ? s.width >= target.up : s.width <= target.down) return steps;
      }
      loc = { ...loc, [tag]: end };
    }
    return steps;
  };

  const up = opts.maxStretch > 1 ? climb('up') : [];
  const down = opts.minStretch < 1 ? climb('down') : [];
  const insts = [...down.reverse(), base, ...up];
  for (const s of insts) {
    for (let gi = 0; gi < run.length; gi++) {
      if (!sameStructure(s.glyphs[gi].commands, base.glyphs[gi].commands)) return fallback(opts);
    }
  }

  // Analyse straight weights on the end steps (and keep the analysis bounds).
  const last = insts.length - 1;
  const steps: WidthStep[] = [];
  for (let k = 0; k <= last; k++) {
    const s = insts[k];
    const analyse = k === 0 || k === last;
    const pg: PlanGlyph[] = [];
    for (let gi = 0; gi < run.length; gi++) {
      const g = s.glyphs[gi];
      const r = run[gi];
      if (g.commands.length === 0) {
        pg.push({
          char: r.char,
          commands: [],
          bounds: { min: 0, max: 0 },
          advanceWidth: g.advanceWidth,
          kernBefore: r.kernBefore,
          bbox: BLANK_BBOX,
          weights: new Float32Array(params.slices),
        });
        continue;
      }
      if (analyse) {
        const res = await client.analyze({
          glyphId: `${r.char}@${s.key}`,
          commands: g.commands,
          advanceWidth: g.advanceWidth,
          axes: ['x'],
          params,
        });
        const px = res.profiles.x!;
        pg.push({
          char: r.char,
          commands: g.commands,
          bounds: px.bounds,
          advanceWidth: g.advanceWidth,
          kernBefore: r.kernBefore,
          bbox: res.bbox,
          weights: px.straight ?? new Float32Array(params.slices),
        });
      } else {
        pg.push({
          char: r.char,
          commands: g.commands,
          bounds: { min: g.bbox.minX, max: g.bbox.maxX },
          advanceWidth: g.advanceWidth,
          kernBefore: r.kernBefore,
          bbox: g.bbox,
          weights: new Float32Array(params.slices),
        });
      }
    }
    steps.push({ glyphs: pg, width: runWidth(pg), location: s.loc });
  }
  return { steps, base: down.length, tracking: opts.tracking ?? defaultTracking(unitsPerEm) };
}

/** No usable design axis: the resting run alone, residual only. */
async function fallback(opts: WidthLadderOptions): Promise<WidthPlan> {
  return planFromRenderGlyphs(opts.glyphs, opts.client, opts.params, opts.tracking ?? defaultTracking(opts.unitsPerEm));
}

/**
 * One-step plan from the resting run (static font, no wdth/XTRA axis, or an
 * injected ParsedFont): straight weights come from the same analysis cache.
 */
export async function planFromRenderGlyphs(
  run: RenderGlyph[],
  client: AnalysisClient,
  params: AnalyzeParams,
  tracking: number,
): Promise<WidthPlan> {
  const pg: PlanGlyph[] = [];
  for (const r of run) {
    let weights: Float32Array;
    if (r.commands.length === 0) weights = new Float32Array(params.slices);
    else {
      const res = await client.analyze({
        glyphId: r.char,
        commands: r.commands,
        advanceWidth: r.advanceWidth,
        axes: ['x'],
        params,
      });
      weights = res.profiles.x?.straight ?? new Float32Array(params.slices);
    }
    pg.push({
      char: r.char,
      commands: r.commands,
      bounds: r.bounds,
      advanceWidth: r.advanceWidth,
      kernBefore: r.kernBefore,
      bbox: r.bbox,
      weights,
    });
  }
  return singleStepPlan(pg, tracking);
}
