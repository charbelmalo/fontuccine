/**
 * engine/attach.ts — `Fontuccine.attach(target, config)`: the `.` entry
 * orchestrator that turns a config + a DOM target into a live stretch instance.
 *
 * Pipeline: config → StretchController (created synchronously so `.set()` and
 * ticker liveness are live immediately) → font load (lazy) → static per-glyph
 * analysis → tier selection → renderer → renderer.attach().
 *
 * CARRIED-FORWARD GUARANTEE (verified in test/engine-guarantee): the renderer is
 * ALWAYS driven by a StretchController, which is the ONLY registrant of a ticker
 * activity predicate (`() => !smoother.settled`). Renderers register NO liveness
 * of their own, so once the spring settles the shared ticker self-parks. This
 * file must never introduce a renderer-owned activity predicate.
 *
 * SSR: importing this module touches no `window`/`document`. All capability
 * probing + DOM work happens inside `attach()`, and `attach()` early-returns an
 * inert instance when there is no document (so wrappers can call it on the server
 * and simply get a no-op until they re-run in a browser effect).
 */
import { createStretchController } from '../interaction/stretch-controller.ts';
import type { StretchController } from '../interaction/stretch-controller.ts';
import { ticker as sharedTicker } from '../interaction/ticker.ts';
import { prefersReducedMotion } from '../interaction/reduced-motion.ts';
import { detectWebGL2 } from '../webgl/gl/capability.ts';
import { probeTier0, cssSupportsFontStretchPercentage } from '../vf/probe.ts';
import { createSvgRenderer } from '../svg/renderer.ts';
import { createWebglRenderer } from '../webgl/renderer.ts';
import { createVfRenderer } from '../vf/renderer.ts';
import { AnalysisClient } from '../worker/client.ts';
import { MsdfClient } from '../webgl/msdf/client.ts';
import { DEFAULT_PARAMS } from '../core/types.ts';
import { loadEngineFont } from './font-load.ts';
import { resolveVariationRequest } from './variations.ts';
import { measureInkDilation } from './ink-calibration.ts';
import { buildGlyphs } from './glyphs.ts';
import { buildWidthLadder, planFromRenderGlyphs } from './width-ladder.ts';
import { defaultTracking } from '../core/width-plan.ts';
import type { WidthPlan } from '../core/width-plan.ts';
import type { RenderGlyph } from './glyphs.ts';
import { selectTier } from './tier-select.ts';
import type { ResolvedTier } from './tier-select.ts';
import type { FontuccineConfig, Instance } from './types.ts';

interface TierRenderer {
  attach(): void;
  destroy(): void;
  /** WebGL renderer only: false ⇒ no usable GL backend, nothing will paint. */
  readonly supported?: boolean;
}

function errMessage(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

function resolveElement(target: string | Element, doc: Document | undefined): HTMLElement {
  if (typeof target === 'string') {
    if (!doc) throw new Error('fontuccine: cannot resolve a selector without a document');
    const el = doc.querySelector(target);
    if (!el) throw new Error(`fontuccine: no element matches "${target}"`);
    return el as HTMLElement;
  }
  return target as HTMLElement;
}

/** Computed font-* of the element → axis request (undefined without a view). */
function resolveElementVariations(el: HTMLElement, doc: Document | undefined): Record<string, number> | undefined {
  const view = doc?.defaultView ?? (typeof window !== 'undefined' ? window : undefined);
  if (!view?.getComputedStyle) return undefined;
  try {
    const cs = view.getComputedStyle(el) as CSSStyleDeclaration & { fontOpticalSizing?: string };
    return resolveVariationRequest({
      fontWeight: cs.fontWeight,
      fontStretch: cs.fontStretch,
      fontStyle: cs.fontStyle,
      fontSize: cs.fontSize,
      fontOpticalSizing: cs.fontOpticalSizing,
      fontVariationSettings: cs.fontVariationSettings,
    });
  } catch {
    return undefined;
  }
}

/** Computed font/colour/smoothing of the element for the ink probe (undefined without a view). */
function readInkStyle(el: HTMLElement, doc: Document | undefined): {
  fontFamily: string; fontWeight: string; fontStretch: string; fontStyle: string; fontSizePx: number;
  fontVariationSettings: string; fontOpticalSizing: string; fontSmoothing: string; color: string;
} | undefined {
  const view = doc?.defaultView ?? (typeof window !== 'undefined' ? window : undefined);
  if (!view?.getComputedStyle) return undefined;
  try {
    const cs = view.getComputedStyle(el) as CSSStyleDeclaration & { fontOpticalSizing?: string; webkitFontSmoothing?: string };
    const fontSizePx = parseFloat(cs.fontSize);
    if (!Number.isFinite(fontSizePx) || fontSizePx <= 0) return undefined;
    return {
      fontFamily: cs.fontFamily,
      fontWeight: cs.fontWeight,
      fontStretch: cs.fontStretch,
      fontStyle: cs.fontStyle,
      fontSizePx,
      fontVariationSettings: cs.fontVariationSettings ?? 'normal',
      fontOpticalSizing: cs.fontOpticalSizing ?? 'auto',
      fontSmoothing: cs.webkitFontSmoothing ?? '',
      color: cs.color,
    };
  } catch {
    return undefined;
  }
}

function defaultIsPrint(doc: Document | undefined): boolean {
  const view = doc?.defaultView ?? (typeof window !== 'undefined' ? window : undefined);
  try {
    return !!view?.matchMedia && view.matchMedia('print').matches;
  } catch {
    return false;
  }
}

export function attach(target: string | Element, config: FontuccineConfig = {}): Instance {
  const doc =
    config.document ?? (typeof document !== 'undefined' ? document : undefined);

  // SSR / no-DOM: hand back an inert instance (wrappers re-attach in an effect).
  if (!doc && typeof target === 'string') {
    return inertInstance('no document (SSR): attach is a no-op until a browser effect');
  }

  const el = resolveElement(target, doc);
  const ticker = config.ticker ?? sharedTicker;
  const unitsPerEm = config.unitsPerEm ?? 1000;

  const min = config.minStretchRatio ?? 1;
  const max = config.maxStretchRatio ?? 4.5;
  const resting = Math.min(Math.max(1, min), max);

  const respectRM = config.respectReducedMotion ?? true;
  const isRM = config.isReducedMotion ?? prefersReducedMotion;

  // --- StretchController (synchronous): owns ticker liveness + `.set()`.
  const controller: StretchController = createStretchController({
    ...(config.trigger ? { trigger: config.trigger } : {}),
    ...(config.axis ? { axis: config.axis } : {}),
    maxStretchRatio: max,
    minStretchRatio: min,
    ...(config.velocityToStretch != null ? { velocityToStretch: config.velocityToStretch } : {}),
    ...(config.proximityRadius != null ? { proximityRadius: config.proximityRadius } : {}),
    ...(config.physics ? { physics: config.physics } : {}),
    ...(config.easingCurve ? { easingCurve: config.easingCurve } : {}),
    ...(config.easingDuration != null ? { easingDuration: config.easingDuration } : {}),
    respectReducedMotion: respectRM,
    isReducedMotion: isRM,
    element: el,
    ticker,
    restingValue: resting,
  });

  const client = config.analysisClient ?? new AnalysisClient();
  const ownsClient = !config.analysisClient;

  let destroyed = false;
  let selectedTier: ResolvedTier | null = null;
  let renderer: TierRenderer | null = null;
  let msdfClient: MsdfClient | null = null;
  const notes: string[] = [];
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });

  async function build(): Promise<void> {
    try {
      const reducedMotion = respectRM && isRM();
      const print = (config.isPrint ?? (() => defaultIsPrint(doc)))();
      const webgl2 = (config.detectWebGL2Support ?? (() => detectWebGL2().supported))();
      const compression = min < 1;

      // Which design instance to render: the element's computed font-* values
      // (what the browser itself draws for it) unless the config says otherwise.
      const variations =
        config.fontVariations === false
          ? undefined
          : (config.fontVariations ?? resolveElementVariations(el, doc));

      // Load outlines + wdth axis (VF may still win; axis needed to probe it).
      const font = await loadEngineFont({
        ...(config.font ? { font: config.font } : {}),
        ...(config.fontUrl ? { fontUrl: config.fontUrl } : {}),
        ...(config.fontBuffer ? { fontBuffer: config.fontBuffer } : {}),
        ...(config.parsedFont ? { parsedFont: config.parsedFont } : {}),
        ...(config.wdthAxis !== undefined ? { wdthAxis: config.wdthAxis } : {}),
        ...(variations ? { variations } : {}),
        unitsPerEm,
      });
      if (destroyed) return;
      const vstat = font.parsed.variation;
      if (vstat && !vstat.applied && vstat.reason && vstat.reason !== 'default-location' && vstat.reason !== 'not-variable') {
        notes.push(`variable-font instancing unavailable (${vstat.reason}); rendering the font's default instance`);
      }

      const vfDecision = probeTier0(font.wdthAxis, {
        maxStretchRatio: max,
        minStretchRatio: min,
        axis: config.axis ?? 'horizontal',
      });
      const vfSupported = vfDecision.supported && cssSupportsFontStretchPercentage();

      const decision = selectTier(config.tier ?? 'auto', {
        webgl2,
        vfSupported,
        reducedMotion,
        print,
        compression,
      });
      selectedTier = decision.tier;
      notes.push(...decision.notes);
      if (destroyed) return;

      const params = {
        ...DEFAULT_PARAMS,
        slices: config.lutResolution ?? DEFAULT_PARAMS.slices,
        k: config.edgeProtection ?? DEFAULT_PARAMS.k,
        maxShareFactor: config.maxShareFactor ?? DEFAULT_PARAMS.maxShareFactor,
      };
      // Glyph analysis is built lazily + once: the VF tier never needs it, but a
      // failed VF/WebGL attach falls back to SVG, which does.
      let glyphs: RenderGlyph[] | null = null;
      const getGlyphs = async (): Promise<RenderGlyph[]> => {
        if (!glyphs) {
          glyphs = await buildGlyphs(font, config.text ?? el.textContent ?? '', client, params, unitsPerEm);
          if (client.mode === 'inline' && client.reason) {
            notes.push(`analysis worker unavailable (${client.reason}); running on main thread`);
          }
        }
        return glyphs;
      };
      // Width plan: the font's own wider (narrower) instances first, then
      // straight-column + tracking residual (core/width-plan.ts). Built once.
      let plan: WidthPlan | null = null;
      const getPlan = async (g: RenderGlyph[]): Promise<WidthPlan> => {
        if (plan) return plan;
        let vf = null;
        if (font.buffer) {
          try {
            const { openVariableFont } = await import('../font/parser.ts');
            vf = openVariableFont(font.buffer, { fontSize: unitsPerEm });
          } catch {
            vf = null;
          }
        }
        plan = vf
          ? await buildWidthLadder({
              font: vf,
              ...(variations ? { base: variations } : {}),
              glyphs: g,
              client,
              params,
              unitsPerEm,
              minStretch: Math.min(1, min),
              maxStretch: Math.max(1, max),
            })
          : await planFromRenderGlyphs(g, client, params, defaultTracking(unitsPerEm));
        return plan;
      };
      // Ink calibration: how much bolder the host's text rasteriser draws these
      // glyphs than their outline (device px per edge). null ⇒ exact outline.
      const resolveInk = async (g: RenderGlyph[]): Promise<number | null> => {
        const want = config.inkDilation ?? 'auto';
        const dpr = (doc?.defaultView?.devicePixelRatio ?? 1) || 1;
        if (typeof want === 'number') return Number.isFinite(want) ? want * dpr : null;
        const style = readInkStyle(el, doc);
        if (!style || !doc) return null;
        const probe = g.filter((x) => x.commands.length > 0 && !/\s/.test(x.char)).slice(0, 4);
        if (probe.length === 0) return null;
        try {
          const cal = await measureInkDilation({
            doc,
            ...style,
            dpr,
            unitsPerEm,
            glyphs: probe.map((x) => ({ char: x.char, glyph: { commands: x.commands, advanceWidth: x.advanceWidth } })),
          });
          if (!cal) {
            notes.push('ink calibration skipped (instance not expressible for a canvas probe); rendering the exact outline');
            return null;
          }
          return cal.dilationDevicePx;
        } catch (err) {
          notes.push(`ink calibration failed (${errMessage(err)}); rendering the exact outline`);
          return null;
        }
      };
      const commonFor = (g: RenderGlyph[], p: WidthPlan | null) => ({
        host: el,
        glyphs: g,
        ...(p ? { plan: p } : {}),
        controller,
        ...(config.text != null ? { text: config.text } : {}),
        wrap: config.wrap ?? 'nowrap',
        maxStretchRatio: max,
        restingStretch: resting,
        unitsPerEm,
        respectReducedMotion: respectRM,
        isReducedMotion: isRM,
        ticker,
        document: doc,
      });

      // Create + attach the selected tier. If it throws (or WebGL reports no
      // usable backend) fall back to SVG so `tier` names what ACTUALLY renders.
      try {
        if (selectedTier === 'vf') {
          if (!font.wdthAxis) throw new Error('fontuccine: VF selected without a wdth axis');
          renderer = createVfRenderer({
            host: el,
            axis: font.wdthAxis,
            controller,
            wrap: config.wrap ?? 'nowrap',
            reserveBasis: config.reserveBasis ?? 'tier-capability',
            maxStretchRatio: max,
            restingStretch: resting,
            respectReducedMotion: respectRM,
            isReducedMotion: isRM,
            ticker,
            document: doc,
          });
        } else {
          const g = await getGlyphs();
          if (destroyed) return;
          const p = await getPlan(g);
          if (destroyed) return;
          const inkDevice = await resolveInk(g);
          if (destroyed) return;
          const dprNow = (doc?.defaultView?.devicePixelRatio ?? 1) || 1;
          const inkCss = inkDevice == null ? 0 : inkDevice / dprNow;
          if (selectedTier === 'webgl') {
            msdfClient = new MsdfClient({
              onFallback: (reason) =>
                notes.push(`MSDF worker unavailable (${reason}); rasterizing on main thread`),
            });
            if (msdfClient.mode === 'inline' && msdfClient.reason) {
              notes.push(`MSDF worker unavailable (${msdfClient.reason}); rasterizing on main thread`);
            }
            const webgl = createWebglRenderer({
              ...commonFor(g, p),
              msdfClient,
              ...(inkDevice != null ? { inkDilation: inkDevice } : {}),
              ...(config.effects ? { effects: config.effects } : {}),
              ...(config.color ? { color: config.color } : {}),
              ...(config.backend ? { backend: config.backend } : {}),
              // The MSDF atlas rasterizes async, so the GL surface stays blank
              // for a few frames: keep the real text readable until the first
              // frame lands, then hide it (no invisible-text gap on rebuild).
              onFirstDraw: () => webgl.overlay.hideText(),
            });
            webgl.overlay.showText();
            renderer = webgl;
          } else {
            renderer = createSvgRenderer({ ...commonFor(g, p), ...(inkCss > 0 ? { inkDilation: inkCss } : {}) });
          }
        }

        if (destroyed) {
          renderer?.destroy();
          renderer = null;
          return;
        }
        if (renderer.supported === false) {
          throw new Error('no usable WebGL2 backend');
        }
        renderer.attach();
      } catch (err) {
        if (selectedTier === 'svg') throw err; // nothing further to fall back to
        notes.push(`${selectedTier} renderer failed (${errMessage(err)}) → falling back to SVG`);
        try {
          renderer?.destroy();
        } catch {
          /* best-effort teardown of the failed tier */
        }
        renderer = null;
        msdfClient?.destroy();
        msdfClient = null;
        const g = await getGlyphs();
        if (destroyed) return;
        let p: WidthPlan | null = null;
        try {
          p = await getPlan(g);
        } catch (planErr) {
          notes.push(`width plan failed (${errMessage(planErr)}); using the legacy flex model`);
        }
        if (destroyed) return;
        selectedTier = 'svg';
        renderer = createSvgRenderer(commonFor(g, p));
        renderer.attach();
      }
    } catch (err) {
      notes.push(`build failed: ${errMessage(err)}`);
    } finally {
      resolveReady();
    }
  }

  void build();

  return {
    set(value: number) {
      controller.set(value);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      renderer?.destroy();
      renderer = null;
      controller.destroy();
      msdfClient?.destroy();
      msdfClient = null;
      if (ownsClient) client.destroy();
    },
    get tier() {
      return selectedTier;
    },
    ready,
    get notes() {
      return notes;
    },
  };
}

function inertInstance(note: string): Instance {
  return {
    set() {},
    destroy() {},
    tier: null,
    ready: Promise.resolve(),
    notes: [note],
  };
}
