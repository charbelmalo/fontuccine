/**
 * webgl/renderer.ts — Fontuccine Tier 1 (WebGL2 + runtime MSDF atlas) renderer.
 *
 * PRIMARY tier (RESEARCH §3). Consumes the SAME frozen surfaces as the SVG tier
 * — `layoutRun` prefix metrics, the flex profiles, the shared overlay, the
 * shared ticker + StretchController — so GPU and SVG geometry match within
 * tolerance (test/webgl-parity). Interface mirrors createSvgRenderer EXACTLY
 * (attach/resize/draw/destroy + element + overlay) so the engine swaps tiers
 * behind one shape.
 *
 * Discipline (CLAUDE.md rules 1,4,6; obligations):
 *  - ONE shared canvas/context for all instances (gl/shared.ts); this renderer
 *    draws into its own screen region via scissor — never a context per element.
 *  - Static-per-glyph work (flex→cumulative-flex LUT, MSDF raster, instance
 *    attributes) is built ONCE off the main thread (MSDF in a worker) and NEVER
 *    per frame. Per frame only `u_growth`/`u_instMix`/`u_origin` (+ effect
 *    scalars) change: zero buffer re-uploads in steady state. With a width plan
 *    the instance buffer is rebuilt only when the frame moves to a different
 *    pair of design instances (a handful of times across a full sweep).
 *  - Writes happen only in the RENDER phase; the only DOM read (host rect) is a
 *    cached READ-phase measure, invalidated by ResizeObserver + scroll.
 *  - Reduced motion / print ⇒ ONE static draw, NO per-frame callback.
 *  - Offscreen ⇒ IntersectionObserver deactivates the instance (RESEARCH §2).
 *  - Context loss ⇒ atlas + LUT + geometry buffers fully restored (obligation 1).
 *
 * The a11y/overlay reconciliation (flagged): "one shared canvas for all
 * instances" and "mount the canvas as the overlay renderLayer" are mutually
 * exclusive for N>1 (a canvas node can live in one host only). The shared-canvas
 * architecture wins; each host gets a transparent, inert PROXY layer through
 * `createOverlay` so ALL the frozen a11y/wrap/containment/destroy behavior is
 * reused, while the pixels come from the shared canvas aligned by scissor.
 */
import type { LayoutGlyph } from '../core/kerning.ts';
import { layoutRun } from '../core/kerning.ts';
import type { Ticker } from '../interaction/ticker.ts';
import { ticker as sharedTicker } from '../interaction/ticker.ts';
import { prefersReducedMotion } from '../interaction/reduced-motion.ts';
import { observeVisibility } from '../interaction/gating.ts';
import type { VisibilityOptions } from '../interaction/gating.ts';
import { createOverlay } from '../dom/overlay.ts';
import type { Overlay, WrapMode } from '../dom/overlay.ts';
import type { WebglGlyph, EffectsConfig, RGBAColor } from './types.ts';
import { buildFlexCumulative } from './parity.ts';
import type { WidthPlan, WidthFrame } from '../core/width-plan.ts';
import { resolveFrame, cumulativeWeights, residualSlopes } from '../core/width-plan.ts';
import type { PathCommand, BBox } from '../core/types.ts';
import { packLUTAtlas } from './lut-texture.ts';
import { MsdfAtlas } from './msdf/atlas.ts';
import { MsdfClient } from './msdf/client.ts';
import type { MSDFBitmap } from './msdf/generator.ts';
import type { RenderBackend, RunHandle, GlyphRunData } from './gl/device.ts';
import { FLOATS_PER_INSTANCE } from './gl/device.ts';
import { acquireSharedBackend, releaseSharedBackend, DEFAULT_GRID_SLICES } from './gl/shared.ts';

const DEFAULT_ATLAS_SIZE = 2048;
const DEFAULT_CELL = 96;

export interface StretchSource {
  readonly value: number;
  /** Optional velocity (for aberration ∝ velocity); 0 when absent. */
  readonly velocity?: number;
}

export interface WebglRendererOptions {
  host: HTMLElement;
  glyphs: WebglGlyph[];
  /**
   * Width plan (core/width-plan.ts): real variable-font instances, then the
   * straight-column + tracking residual. When given it drives every frame and
   * `glyphs[i].flex` is unused; without it the legacy flex-slice model runs.
   */
  plan?: WidthPlan;
  controller: StretchSource;
  text?: string;
  wrap?: WrapMode;
  maxStretchRatio?: number;
  restingStretch?: number;
  unitsPerEm?: number;
  /** Ink color (straight alpha, 0..1). Default: the host's computed CSS `color`. */
  color?: RGBAColor;
  effects?: EffectsConfig;
  /** MSDF raster size in px per em. Default 64. */
  fontSizeRaster?: number;
  /** MSDF distance range in texels. Default 8. */
  pxRange?: number;
  ticker?: Ticker;
  document?: Document;
  respectReducedMotion?: boolean;
  isReducedMotion?: () => boolean;
  /** Device pixel ratio source (default: window.devicePixelRatio or 1). */
  dpr?: number;
  /** Extra ink per edge in DEVICE px so the MSDF fill matches the host's native
   *  text rasteriser (see engine/ink-calibration.ts). Default 0 = exact outline. */
  inkDilation?: number;
  /** Injected backend (tests). Omit to use the shared page-global backend. */
  backend?: RenderBackend;
  /** Injected MSDF client (tests / shared). Omit to create one. */
  msdfClient?: MsdfClient;
  /** Visibility gate factory (tests). */
  visibilityFactory?: VisibilityOptions['factory'];
  /** Called once, right after the first frame is blitted into the host's surface. */
  onFirstDraw?: () => void;
}

export interface WebglRenderer {
  attach(): void;
  resize(): void;
  draw(now?: number): void;
  destroy(): void;
  /** True when WebGL2 is available; false ⇒ engine must drop to the SVG tier. */
  readonly supported: boolean;
  /** The shared (offscreen) GL surface, or null when unsupported. */
  readonly element: HTMLCanvasElement | null;
  /** This host's visible canvas (inside the host's render layer), or null. */
  readonly surface: HTMLCanvasElement | null;
  readonly overlay: Overlay;
}

/** One glyph of one design instance (a plan step; the legacy model has one step). */
interface GlyphStatic {
  originFactor: number; // font units (prefixAdvance + bounds.min) at growth 0
  width: number; // font units (bounds.max - bounds.min)
  bounds: { min: number; max: number };
  yTop: number; // font units from run top
  height: number; // font units
  commands: PathCommand[];
  bbox: BBox;
  glyphKey: string; // atlas / MSDF cache key (unique per step)
  bitmap?: MSDFBitmap;
  uv?: { origin: [number, number]; size: [number, number] };
}

/** Atlas rect + padding of one glyph cell, in the instance attribute units. */
interface CellRect {
  uv: [number, number, number, number];
  pad: [number, number, number, number]; // ink-width / ink-height units
}

export function createWebglRenderer(options: WebglRendererOptions): WebglRenderer {
  const {
    host,
    glyphs,
    controller,
    wrap = 'nowrap',
    maxStretchRatio = 4.5,
    restingStretch = 1,
    unitsPerEm = 1000,
    fontSizeRaster = 64,
    pxRange = 8,
  } = options;

  const ticker = options.ticker ?? sharedTicker;
  const doc = options.document ?? host.ownerDocument;
  if (!doc) throw new Error('createWebglRenderer: no document available');
  const respectRM = options.respectReducedMotion ?? true;
  const isRM = options.isReducedMotion ?? prefersReducedMotion;
  let color: RGBAColor = options.color ?? { r: 0, g: 0, b: 0, a: 1 };
  const colorFromCss = !options.color; // follow the host's computed CSS color
  const effects = options.effects ?? {};
  const plan = options.plan;
  const slices = glyphs[0]?.flex.length ?? DEFAULT_GRID_SLICES;

  // Acquire the shared backend (or the injected one). Null ⇒ unsupported.
  const backend = options.backend ?? acquireSharedBackend(slices);
  const usingShared = !options.backend;
  const supported = !!backend && backend.supported;

  const msdf = options.msdfClient ?? new MsdfClient();
  const ownsMsdf = !options.msdfClient;

  // Shared MSDF atlas (slot LRU). One per renderer instance's glyph set; the
  // backend's atlas texture is shared, cells are packed here.
  const rasterPad = Math.ceil(pxRange / 2) + 2; // generator default padding
  // Cells must hold the widest instance's raster (a wdth/XTRA max 'W' can be
  // ~1.4 em wide); an undersized cell would spill into its neighbour.
  let widestEm = 1.25;
  for (const sr of plan ? plan.steps.map((st) => st.glyphs) : glyphs.length ? [glyphs] : []) {
    for (const g of sr) {
      const w = (g.bbox.maxX - g.bbox.minX) / unitsPerEm;
      const h = (g.bbox.maxY - g.bbox.minY) / unitsPerEm;
      if (Number.isFinite(w) && w > widestEm) widestEm = w;
      if (Number.isFinite(h) && h > widestEm) widestEm = h;
    }
  }
  const cellSize = Math.max(DEFAULT_CELL, Math.ceil(fontSizeRaster * widestEm) + 2 * rasterPad + 2);
  const atlas = new MsdfAtlas({ size: DEFAULT_ATLAS_SIZE, cellSize, dpr: options.dpr ?? 1 });

  // --- proxy render layer (inert) so the frozen overlay machinery applies.
  const proxy = doc.createElement('div');
  proxy.setAttribute('data-fontuccine', 'webgl');
  // Visible per-host surface: the shared GL canvas is offscreen; each frame the
  // run is drawn there (scissored at the origin) and blitted into this canvas,
  // which lives inside the host's render layer → correct stacking (modals stay
  // on top) and no page-global fixed layer.
  const surface = doc.createElement('canvas');
  surface.setAttribute('data-fontuccine', 'webgl-surface');
  surface.setAttribute('aria-hidden', 'true');
  Object.assign(surface.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    display: 'block',
    pointerEvents: 'none',
  } as CSSStyleDeclaration);
  proxy.appendChild(surface);
  let surfaceCtx: CanvasRenderingContext2D | null = null;
  let surfW = 0;
  let surfH = 0;
  let onFirstDraw = options.onFirstDraw;
  const overlay = createOverlay({
    host,
    renderLayer: proxy,
    text: options.text,
    wrap,
    maxStretchRatio,
    document: doc,
  });

  // --- STATIC per-glyph layout + LUT (computed once; never per frame).
  const layoutGlyphs: LayoutGlyph[] = glyphs.map((g) => ({
    profile: g.flex,
    bounds: g.bounds,
    advanceWidth: g.advanceWidth,
    kernBefore: g.kernBefore,
  }));

  // Design instances: the plan's steps, or the single legacy run.
  const stepRuns: Array<ReadonlyArray<{ char?: string; commands: PathCommand[]; bounds: { min: number; max: number }; advanceWidth: number; kernBefore?: number; bbox: BBox }>> =
    plan ? plan.steps.map((st) => st.glyphs) : [glyphs];
  const stepKeys = plan
    ? plan.steps.map((st, k) => (st.location ? JSON.stringify(st.location) : `step${k}`))
    : [''];

  // Run vertical extent over every instance (SVG-down: minY is the top).
  let maxAscent = -Infinity;
  let minDescent = Infinity;
  for (const sr of stepRuns) {
    for (const g of sr) {
      if (g.commands.length === 0) continue;
      if (g.bbox.maxY > maxAscent) maxAscent = g.bbox.maxY;
      if (g.bbox.minY < minDescent) minDescent = g.bbox.minY;
    }
  }
  if (!Number.isFinite(maxAscent)) {
    maxAscent = unitsPerEm;
    minDescent = 0;
  }

  // prefixAdvance_i in font units (matches layoutRun's cursor derivation).
  const stepStatics: GlyphStatic[][] = stepRuns.map((sr, k) => {
    const out: GlyphStatic[] = [];
    let prefix = 0;
    for (let i = 0; i < sr.length; i++) {
      const g = sr[i];
      prefix += g.kernBefore ?? 0; // prefixAdvance_i = kernBefore_i + Σ_{j<i}(adv_j + kern_j)
      const key = g.char ?? `g${i}`;
      out.push({
        originFactor: prefix + g.bounds.min,
        width: g.bounds.max - g.bounds.min,
        bounds: { min: g.bounds.min, max: g.bounds.max },
        yTop: g.bbox.minY - minDescent,
        height: g.bbox.maxY - g.bbox.minY,
        commands: g.commands,
        bbox: g.bbox,
        glyphKey: plan ? `${key}@${stepKeys[k]}` : key,
      });
      prefix += g.advanceWidth; // advance for the NEXT glyph's prefix
    }
    return out;
  });
  const legacyLUT = plan ? null : glyphs.map((g) => buildFlexCumulative(g.flex));
  const runFontUnitsHeight = maxAscent - minDescent;

  // --- lifecycle state
  let attached = false;
  let ready = false;
  let visible = true;
  let lastStretch = Number.NaN;
  let rectDirty = true;
  let hostRect: { x: number; y: number; w: number; h: number } | null = null;
  let fontSizePx = fontSizeRaster; // css px/em; refined from the host in READ
  let run: RunHandle | null = null;
  const unsubs: Array<() => void> = [];
  let resizeObserver: ResizeObserver | null = null;
  let scrollHandler: (() => void) | null = null;
  let visibilityStop: (() => void) | null = null;
  let lostUnsub: (() => void) | null = null;
  let restoredUnsub: (() => void) | null = null;
  let destroyed = false;

  const dpr = (): number => options.dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

  // --- lazy displacement-noise load (zero-cost until an enabled effect asks).
  let noiseLoaded = false;
  function loadNoiseIfNeeded(): void {
    if (noiseLoaded || destroyed) return;
    const disp = effects.displacement;
    if (!disp || !disp.texture || (disp.intensity ?? 0) <= 0) return;
    if (!backend || typeof backend.setNoise !== 'function') return;
    if (typeof Image === 'undefined') return; // SSR / headless: skip silently
    noiseLoaded = true; // guard against duplicate in-flight loads
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (destroyed || !backend) return;
      backend.setNoise?.(img);
      lastStretch = Number.NaN; // force a repaint now that warp is available
      ticker.wake();
    };
    img.onerror = () => {
      noiseLoaded = false; // allow a later retry; displacement stays disabled
    };
    img.src = disp.texture;
  }

  /** Exact atlas rect of a glyph's INK box + its padding (ink units). */
  function cellRect(s: GlyphStatic, fresh: boolean): CellRect | null {
    const bmp = s.bitmap;
    if (!bmp || !backend) return null;
    const cell = atlas.acquire(s.glyphKey, bmp.width, bmp.height);
    const { x: cx, y: cy } = atlas.cellOrigin(cell.slot);
    if (cell.isNew || fresh) backend.uploadAtlasCell(cx, cy, bmp);
    // EXACT atlas UV rect for this glyph's INK box (box [0,1]² ↔ the float
    // texel extents of [bounds.min,bounds.max]×[bbox.minY,bbox.maxY]; no
    // ceil'd sizes, so registration is exact to the texel), plus the padding
    // extents so the quad also covers the anti-aliasing ramp (a_quad).
    const S = DEFAULT_ATLAS_SIZE;
    const pad = bmp.padding;
    const originX = bmp.originX ?? bmp.bbox.minX - pad / bmp.scale;
    const originY = bmp.originY ?? bmp.bbox.maxY + pad / bmp.scale;
    const tx0 = (s.bounds.min - originX) * bmp.scale; // ink left, texels from cell left
    const tx1 = (s.bounds.max - originX) * bmp.scale;
    const inkW = Math.max(1e-6, tx1 - tx0);
    const tyTop = (originY - bmp.bbox.minY) * bmp.scale; // visual top, rows from cell top
    const tyBot = (originY - bmp.bbox.maxY) * bmp.scale; // visual bottom (= pad)
    const inkH = Math.max(1e-6, tyTop - tyBot);
    const uvOx = (cx + tx0) / S;
    const uvOy = (cy + tyTop) / S; // box y=0 (visual top)
    const uvSx = inkW / S;
    const uvSy = -inkH / S; // box y=1 (visual bottom)
    s.uv = { origin: [uvOx, uvOy], size: [uvSx, uvSy] };
    return {
      uv: [uvOx, uvOy, uvSx, uvSy],
      pad: [tx0 / inkW, (bmp.width - tx1) / inkW, (bmp.height - tyTop) / inkH, tyBot / inkH],
    };
  }

  /** Which instance pair (+ residual direction) the uploaded buffer encodes. */
  let uploadedPair = '';
  /** Font-unit geometry of the uploaded pair (runExtent without a GPU readback). */
  let pairGeom: Float64Array = new Float64Array(0); // per glyph: L0 L1 W0 W1 slopeL slopeInk
  const LEGACY_FRAME: WidthFrame = { k0: 0, k1: 0, t: 0, growth: 1, saturated: false };
  const pairKey = (f: WidthFrame): string =>
    `${live.v}:${f.k0},${f.k1},${f.growth > 0 ? '+' : f.growth < 0 ? '-' : '0'}`;

  // Progressive atlas: a plan can hold a dozen-plus instances, and rasterising
  // every one before the first frame delays it by ~1 s for a phrase. The
  // instances the resting / extreme frames need are rasterised first; the rest
  // stream in behind. Until then frames resolve over the LOADED instances only
  // (`live.plan`, same total width, a coarser blend between the loaded ones),
  // so the run is never drawn at the wrong width while the ladder fills in.
  const stepLoaded: boolean[] = stepStatics.map(() => false);
  let live: { plan: WidthPlan | null; map: number[]; v: number } = { plan: null, map: [0], v: 0 };
  function refreshLive(): void {
    const map: number[] = [];
    for (let k = 0; k < stepStatics.length; k++) if (stepLoaded[k] || !plan) map.push(k);
    let lp: WidthPlan | null = null;
    if (plan) {
      lp = map.length === plan.steps.length
        ? plan
        : { ...plan, steps: map.map((k) => plan.steps[k]), base: Math.max(0, map.indexOf(plan.base)) };
    }
    live = { plan: lp, map, v: live.v + 1 };
  }
  /** Frame for a stretch over the loaded instances (indices into `live.map`). */
  const liveFrame = (stretch: number): WidthFrame =>
    live.plan ? resolveFrame(live.plan, stretch) : LEGACY_FRAME;

  /**
   * Build + upload the instance buffer and LUT for one instance pair.
   * `full` re-assigns every atlas cell (first build, context restore, font-size
   * change); a pair switch only adds the cells it is missing.
   */
  function assembleAndUpload(frame: WidthFrame = liveFrame(Math.max(1, lastStretch || restingStretch)), full = true): void {
    if (!backend || destroyed) return;
    backend.ensureAtlas(DEFAULT_ATLAS_SIZE);
    if (full) atlas.clear(); // fresh slot assignment (also used on context restore)

    const n = stepStatics[0].length;
    const s0 = stepStatics[live.map[frame.k0]];
    const s1 = stepStatics[live.map[frame.k1]];
    const instances = new Float32Array(n * FLOATS_PER_INSTANCE);
    const geom = new Float64Array(n * 6);
    const emPx = fontSizePx / unitsPerEm; // font units → css px
    const luts: Float32Array[] = [];

    // Residual slopes (font units per unit growth) on the pair's second step.
    const lp = live.plan;
    const planGlyphs = lp ? lp.steps[frame.k1].glyphs : null;
    const slopes = lp ? residualSlopes(lp, frame.k1, frame.growth) : null;

    for (let i = 0; i < n; i++) {
      const a = s0[i];
      const b = s1[i];
      let slopeLeft: number;
      let slopeInk: number;
      if (planGlyphs && slopes) {
        slopeLeft = slopes[i].left;
        slopeInk = slopes[i].ink;
        luts.push(cumulativeWeights(planGlyphs[i].weights));
      } else {
        // legacy flex model: posX = s·origin + W·(u + (s−1)·C(u))
        slopeLeft = a.originFactor;
        slopeInk = a.width;
        luts.push(legacyLUT![i]);
      }
      const g = i * 6;
      geom[g] = a.originFactor;
      geom[g + 1] = b.originFactor;
      geom[g + 2] = a.width;
      geom[g + 3] = b.width;
      geom[g + 4] = slopeLeft;
      geom[g + 5] = slopeInk;

      const ca = cellRect(a, full);
      const cb = b === a ? ca : cellRect(b, full);
      if (!ca || !cb) continue;
      const o = i * FLOATS_PER_INSTANCE;
      instances[o + 0] = a.originFactor * emPx; // css px
      instances[o + 1] = b.originFactor * emPx;
      instances[o + 2] = a.width * emPx;
      instances[o + 3] = b.width * emPx;
      instances[o + 4] = a.yTop * emPx;
      instances[o + 5] = a.height * emPx;
      instances[o + 6] = b.yTop * emPx;
      instances[o + 7] = b.height * emPx;
      instances.set(ca.uv, o + 8);
      instances.set(cb.uv, o + 12);
      instances[o + 16] = i; // lut row
      instances[o + 17] = slopeLeft * emPx;
      instances[o + 18] = slopeInk * emPx;
      // Both fields are sampled at the same box coordinate: extend the quad only
      // as far as BOTH cells have padding, so neither sample leaves its cell.
      instances[o + 19] = Math.min(ca.pad[0], cb.pad[0]);
      instances[o + 20] = Math.min(ca.pad[1], cb.pad[1]);
      instances[o + 21] = Math.min(ca.pad[2], cb.pad[2]);
      instances[o + 22] = Math.min(ca.pad[3], cb.pad[3]);
    }

    const data: GlyphRunData = {
      instances,
      instanceCount: n,
      lutAtlas: packLUTAtlas(luts),
      slices,
    };
    if (!run) run = backend.createRun();
    run.upload(data);
    pairGeom = geom;
    uploadedPair = live.plan ? pairKey(frame) : 'legacy';
  }

  // --- MSDF generation (worker / inline), one instance at a time in priority
  //     order. Resolves once the FIRST group (resting pair, base, both ends of
  //     the ladder) is in; the remaining instances keep streaming afterwards.
  const rasterJobs = new Map<string, Promise<MSDFBitmap>>();
  function rasterStep(k: number): Promise<void> {
    const jobs: Array<Promise<void>> = [];
    for (const s of stepStatics[k]) {
      if (s.commands.length === 0) continue;
      let p = rasterJobs.get(s.glyphKey);
      if (!p) {
        p = msdf.generate({
          glyphId: `${s.glyphKey}@${fontSizeRaster}`,
          commands: s.commands,
          options: { bbox: s.bbox, fontSize: fontSizeRaster, unitsPerEm, pxRange },
          dpr: options.dpr ?? 1,
        });
        rasterJobs.set(s.glyphKey, p);
      }
      jobs.push(
        p.then((bmp) => {
          s.bitmap = bmp;
        }),
      );
    }
    return Promise.all(jobs).then(() => {
      stepLoaded[k] = true;
    });
  }

  function generateAtlas(): Promise<void> {
    const K = stepStatics.length;
    if (!plan) return rasterStep(0).then(() => refreshLive());
    const rest = plan.steps[plan.base] ? resolveFrame(plan, Math.max(1, restingStretch)) : null;
    const first = new Set<number>([plan.base, K - 1]);
    if (rest) {
      first.add(rest.k0);
      first.add(rest.k1);
    }
    const order = [...first];
    const later: number[] = [];
    for (let k = 0; k < K; k++) if (!first.has(k)) later.push(k);
    later.sort((a, b) => Math.abs(a - plan.base) - Math.abs(b - plan.base));
    return Promise.all(order.map(rasterStep)).then(() => {
      refreshLive();
      // Stream the rest sequentially (keeps the raster worker's queue short so a
      // font-size change or destroy is not stuck behind a long backlog).
      let chain = Promise.resolve();
      for (const k of later) {
        chain = chain.then(() => {
          if (destroyed) return;
          return rasterStep(k).then(() => {
            if (destroyed) return;
            refreshLive();
            lastStretch = Number.NaN; // re-resolve the frame over the finer ladder
            ticker.wake();
          });
        });
      }
      chain.catch(() => {
        /* a failed instance stays unloaded; frames keep using the loaded ones */
      });
    });
  }

  /** Parse a computed CSS color (`rgb()` / `rgba()`) into straight-alpha 0..1. */
  function parseCssColor(css: string): RGBAColor | null {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i.exec(css.trim());
    if (!m) return null;
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: Number.isFinite(a) ? a : 1 };
  }

  /** WebGL ink follows the host's computed `color` (like the SVG tier's currentColor). */
  function readColor(): void {
    if (!colorFromCss) return;
    const view = doc.defaultView;
    if (!view) return;
    const c = parseCssColor(view.getComputedStyle(host).color);
    if (c && (c.r !== color.r || c.g !== color.g || c.b !== color.b || c.a !== color.a)) {
      color = c;
      lastStretch = Number.NaN; // force a repaint
    }
  }

  /** CSS px the run needs for a frame (ink + AA padding), never below the host box. */
  function runExtent(growth: number, mix: number): { w: number; h: number } {
    const emPx = fontSizePx / unitsPerEm;
    let right = hostRect?.w ?? 0;
    let bottom = hostRect?.h ?? 0;
    for (let k = 0; k < stepStatics.length; k++) {
      for (const s of stepStatics[k]) {
        const bmp = s.bitmap;
        const padPx = bmp ? (bmp.padding / bmp.scale) * emPx : 0;
        const b = (s.yTop + s.height) * emPx + 2 * padPx;
        if (b > bottom) bottom = b;
      }
    }
    const n = pairGeom.length / 6;
    for (let i = 0; i < n; i++) {
      const g = i * 6;
      const s = stepStatics[0][i];
      const bmp = s.bitmap;
      const padPx = bmp ? (bmp.padding / bmp.scale) * emPx : 0;
      const left = pairGeom[g] + mix * (pairGeom[g + 1] - pairGeom[g]);
      const width = pairGeom[g + 2] + mix * (pairGeom[g + 3] - pairGeom[g + 2]);
      const r = (left + width + growth * (pairGeom[g + 4] + pairGeom[g + 5])) * emPx + 2 * padPx;
      if (r > right) right = r;
    }
    return { w: Math.ceil(right), h: Math.ceil(bottom) };
  }

  /** Grow the per-host surface (never shrink) so the stretched run is never clipped. */
  function ensureSurface(growth: number, mix: number, d: number): void {
    const need = runExtent(growth, mix);
    if (need.w > surfW || need.h > surfH) {
      surfW = Math.max(surfW, Math.ceil(need.w * 1.25));
      surfH = Math.max(surfH, need.h);
    }
    const bw = Math.max(1, Math.round(surfW * d));
    const bh = Math.max(1, Math.round(surfH * d));
    if (surface.width !== bw || surface.height !== bh) {
      surface.width = bw;
      surface.height = bh;
      surface.style.width = `${surfW}px`;
      surface.style.height = `${surfH}px`;
    }
    if (!surfaceCtx) surfaceCtx = surface.getContext('2d');
  }

  function readPhase(): void {
    if (!rectDirty) return;
    rectDirty = false;
    overlay.measure();
    readColor();
    // Host screen rect in CSS px (single getBoundingClientRect).
    const r = host.getBoundingClientRect();
    hostRect = { x: r.left, y: r.top, w: r.width, h: r.height };
    // Track the host's rendered em size so glyph metrics scale with CSS.
    const view = doc.defaultView;
    if (view) {
      const fs = parseFloat(view.getComputedStyle(host).fontSize);
      if (Number.isFinite(fs) && fs > 0 && Math.abs(fs - fontSizePx) > 0.01) {
        fontSizePx = fs;
        if (ready) assembleAndUpload(); // font-size changed → rebuild static px attrs
      }
    }
  }

  function frameEffects(velocity: number): {
    grain: number;
    aberration: number;
    disp: number;
    dispScale: [number, number];
  } {
    const grain = effects.grain ?? 0;
    let aberration = 0;
    if (effects.aberration) {
      aberration = effects.aberration.fromVelocity
        ? Math.min(effects.aberration.max, Math.abs(velocity) * effects.aberration.max)
        : effects.aberration.max;
    }
    const disp = effects.displacement?.intensity ?? 0;
    const dispScale = effects.displacement?.scale ?? [1, 1];
    return { grain, aberration, disp, dispScale };
  }

  function paint(rawStretch: number, now: number): void {
    if (!backend || !run || !ready || !visible || !hostRect) return;
    if (backend.isContextLost()) return;
    // ── Tier-safety guard: WebGL is a STRETCH-ONLY tier ──────────────────────
    // The stretch-independent LUT form `uOrig + (u_stretch-1)·C(u)` is exact and
    // monotonic for stretch ≥ 1, but has NO lower guard: for stretch < 1 it folds
    // geometry over (inverts) on high-flex glyphs, violating the I5/monotonicity
    // invariant. The core's nonlinear water-fill compression guard (core/lut.ts)
    // lives on the frozen CPU side and is NOT reproducible by this linear-in-
    // stretch shader, so compression is the SVG (vector-fidelity) tier's job
    // (RESEARCH §3). We therefore clamp any stretch < 1 to identity (1) at the
    // GPU draw boundary — the shader renders identity-or-stretch and can never
    // fold. This covers BOTH reachable sub-unity paths: a config `minStretchRatio
    // < 1`, and an underdamped spring undershooting below its resting target
    // (stretch-controller emits unclamped `.value`).
    //
    // FUTURE HOOK (do NOT implement here — pending architect/user decision): when
    // effective stretch < 1, dispatch this run to the SVG tier for true
    // compression fidelity instead of clamping to identity. That routing belongs
    // at the engine/tier-selection layer, not inside the GPU renderer.
    const stretch = Math.max(1, rawStretch);
    lastStretch = stretch;
    // Width plan: resolve the instance pair + residual; switch the uploaded pair
    // only when the frame crosses into a different one.
    let growth = stretch - 1;
    let instMix = 0;
    if (live.plan) {
      const frame = liveFrame(stretch);
      if (pairKey(frame) !== uploadedPair) assembleAndUpload(frame, false);
      growth = frame.growth;
      instMix = frame.k0 === frame.k1 ? 0 : frame.t;
    }
    const d = dpr();
    ensureSurface(growth, instMix, d);
    // The shared GL canvas is an offscreen scratch surface: draw this run at
    // its origin (scissored to the surface size), then blit into the host's
    // canvas. Grow-only so hosts sharing the canvas never thrash its size.
    const glCanvas = backend.canvas;
    const curW = glCanvas ? glCanvas.width / d : 0;
    const curH = glCanvas ? glCanvas.height / d : 0;
    backend.ensureSize(Math.max(surfW, curW), Math.max(surfH, curH), d);
    backend.beginFrame(now);
    const region = { x: 0, y: 0, w: surfW, h: surfH };

    const velocity = controller.velocity ?? 0;
    const fx = frameEffects(velocity);
    run.draw({
      region,
      dpr: d,
      stretch,
      growth,
      instMix,
      origin: 0,
      color,
      pxRange,
      atlasSize: DEFAULT_ATLAS_SIZE,
      grain: fx.grain,
      aberration: fx.aberration,
      inkDilate: options.inkDilation ?? 0,
      stretchDir: [1, 0], // horizontal axis only
      time: now * 0.001,
      dispIntensity: fx.disp,
      dispScale: fx.dispScale,
    });

    // Blit the region into the host's own canvas (same task as the draw, so the
    // GL drawing buffer is still intact regardless of preserveDrawingBuffer).
    if (glCanvas && surfaceCtx) {
      const bw = surface.width;
      const bh = surface.height;
      surfaceCtx.clearRect(0, 0, bw, bh);
      try {
        surfaceCtx.drawImage(glCanvas, 0, 0, bw, bh, 0, 0, bw, bh);
        if (onFirstDraw) { const cb = onFirstDraw; onFirstDraw = undefined; cb(); }
      } catch {
        /* detached / zero-size GL canvas: nothing to show this frame */
      }
    }
  }

  function draw(now = 0): void {
    if (!ready || !visible) return;
    // Clamp to the tier-safe floor (see paint()) BEFORE the settle-skip compare:
    // a sub-unity controller value (config minStretchRatio<1, or an underdamped
    // spring undershooting toward a resting target) maps to identity here, so a
    // run resting below 1 settles/skips instead of re-drawing an identity frame
    // every frame, and sub-unity spring wiggle draws nothing.
    const stretch = Math.max(1, controller.value);
    const hasVelocityFx = !!effects.aberration?.fromVelocity && (controller.velocity ?? 0) !== 0;
    if (stretch === lastStretch && !hasVelocityFx) return; // settled → skip
    paint(stretch, now);
  }

  function onRestore(): void {
    // Context restored: atlas texture, LUT texture, geometry + instance buffers
    // are all gone. Re-ensure + re-upload everything from cached statics/bitmaps.
    if (!backend || destroyed) return;
    assembleAndUpload();
    lastStretch = Number.NaN; // force a repaint
    ticker.wake();
  }

  function subscribeAnimated(): void {
    unsubs.push(ticker.read(readPhase));
    unsubs.push(ticker.render((now) => draw(now)));

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        rectDirty = true;
        ticker.wake();
      });
      resizeObserver.observe(host);
    }
    const view = doc.defaultView;
    if (view) {
      scrollHandler = () => {
        rectDirty = true;
        ticker.wake();
      };
      view.addEventListener('scroll', scrollHandler, { passive: true });
    }

    // Offscreen ⇒ idle (RESEARCH §2). observeVisibility fires true synchronously
    // when no IO is available (headless), so work still runs.
    visibilityStop = observeVisibility(
      host,
      (v) => {
        visible = v;
        if (v) {
          rectDirty = true;
          ticker.wake();
        }
      },
      options.visibilityFactory ? { factory: options.visibilityFactory } : {},
    );
  }

  function attach(): void {
    if (attached || destroyed) return;
    attached = true;
    if (!supported || !backend) return; // engine drops to SVG tier

    lostUnsub = backend.onContextLost(() => {
      /* preventDefault handled in backend; nothing to draw while lost */
    });
    restoredUnsub = backend.onContextRestored(onRestore);

    // Build atlas + run, then paint. Static work; async only for the raster.
    generateAtlas().then(() => {
      if (destroyed) return;
      ready = true;
      // First measure (host rect + font-size) then assemble with real px.
      overlay.measure();
      readColor();
      const r = host.getBoundingClientRect();
      hostRect = { x: r.left, y: r.top, w: r.width, h: r.height };
      const view = doc.defaultView;
      if (view) {
        const fs = parseFloat(view.getComputedStyle(host).fontSize);
        if (Number.isFinite(fs) && fs > 0) fontSizePx = fs;
      }
      assembleAndUpload();
      loadNoiseIfNeeded();

      if (respectRM && isRM()) {
        // Reduced motion / print: ONE static draw, NO per-frame subscription.
        paint(restingStretch, 0);
        return;
      }
      subscribeAnimated();
      ticker.wake();
    });
  }

  function resize(): void {
    rectDirty = true;
    ticker.wake();
  }

  function destroy(): void {
    destroyed = true;
    for (const u of unsubs) u();
    unsubs.length = 0;
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (scrollHandler && doc.defaultView) {
      doc.defaultView.removeEventListener('scroll', scrollHandler);
      scrollHandler = null;
    }
    if (visibilityStop) {
      visibilityStop();
      visibilityStop = null;
    }
    if (lostUnsub) lostUnsub();
    if (restoredUnsub) restoredUnsub();
    if (run) {
      run.dispose();
      run = null;
    }
    surface.remove();
    surfaceCtx = null;
    overlay.destroy();
    if (ownsMsdf) msdf.destroy();
    if (usingShared && backend) releaseSharedBackend();
    attached = false;
  }

  return {
    attach,
    resize,
    draw,
    destroy,
    supported,
    get element() {
      return backend?.canvas ?? null;
    },
    get surface() {
      return supported ? surface : null;
    },
    overlay,
  };
}
