/**
 * engine/types.ts — the public `Fontuccine.attach` config + instance types.
 *
 * The DOCUMENTED public schema is exactly README.md's "Public API sketch" plus
 * the ONE approved additive field `reserveBasis` (Phase-5 §4). The remaining
 * fields below the divider are ADVANCED / INJECTABLE seams (font source, DI for
 * tests, SSR document) — deliberately NOT part of the documented schema, exactly
 * as `StretchControllerConfig` carries `element`/`ticker`/`stimulus`. They never
 * change the meaning of a documented field.
 */
import type { EffectsConfig, RGBAColor } from '../webgl/types.ts';
import type { WrapMode, ReserveBasis } from '../dom/overlay.ts';
import type { WdthAxis } from '../vf/detect.ts';
import type { ParsedFont } from '../font/parser.ts';
import type { Ticker } from '../interaction/ticker.ts';
import type { AnalysisClient } from '../worker/client.ts';
import type { RenderBackend } from '../webgl/gl/device.ts';
import type { Tier, ResolvedTier } from './tier-select.ts';

export type { Tier, ResolvedTier } from './tier-select.ts';
/**
 * Stretch axis. **Only `'horizontal'` is rendered in 0.1.x.** `'vertical'` and
 * `'dual'` are accepted for forward compatibility (the math core can analyse a
 * y-axis field) but none of the three renderers applies a vertical remap yet;
 * passing either logs a one-time `console.warn` and renders horizontally.
 */
export type StretchAxis = 'horizontal' | 'vertical' | 'dual';
export type Trigger = 'scroll-velocity' | 'mouse-proximity' | 'hover' | 'custom';

/** A source for the font outline binary (needed by the SVG/WebGL tiers). */
export type FontSource =
  | { url: string }
  | { buffer: ArrayBuffer | ArrayBufferView }
  | { parsed: ParsedFont; wdthAxis?: WdthAxis | null };

export interface FontuccineConfig {
  // ─────────────── documented public schema (README.md) ───────────────
  /** Only `'horizontal'` is implemented in 0.1.x — see {@link StretchAxis}. */
  axis?: StretchAxis;
  trigger?: Trigger;

  maxStretchRatio?: number;
  minStretchRatio?: number;
  /** Pagurek's k (edge protection): high = hard 9-slice, low = uniform. */
  edgeProtection?: number;
  /** Slices per axis (analysis LUT resolution). */
  lutResolution?: number;
  /**
   * Cap on the share of the total growth a single slice may absorb, as a
   * multiple of its even share (1/slices). Default 4. Keeps diagonal-only
   * glyphs (`w`, `v`, `y`) from collapsing their apexes into a slab at high
   * ratios; `Infinity` disables the cap (raw tangent-aligned profile).
   */
  maxShareFactor?: number;

  physics?: { stiffness?: number; damping?: number };
  easingCurve?: string;
  easingDuration?: number;
  proximityRadius?: number;
  velocityToStretch?: number;

  tier?: Tier;
  /** Tier-1 (WebGL) only; ignored by the SVG/VF tiers. */
  effects?: EffectsConfig;

  wrap?: WrapMode;
  respectReducedMotion?: boolean;

  /**
   * APPROVED additive field (Phase-5 §4). How `wrap:'reserve'` sizes the box:
   *  - 'tier-capability' (default): each tier reserves what it can actually paint
   *    (SVG/WebGL × maxStretchRatio, VF × axis-max).
   *  - 'uniform': every tier reserves × maxStretchRatio for cross-tier
   *    consistency (VF then leaves a permanent gap).
   */
  reserveBasis?: ReserveBasis;

  // ─────────── advanced / injectable (NOT the documented schema) ───────────
  /** Text to stretch (defaults to the target element's textContent). */
  text?: string;
  /** Ink color (WebGL tier). Default opaque black. */
  color?: RGBAColor;

  /** Font outline source. `fontUrl`/`fontBuffer`/`parsedFont` are conveniences. */
  font?: FontSource;
  fontUrl?: string;
  fontBuffer?: ArrayBuffer | ArrayBufferView;
  parsedFont?: ParsedFont;
  /** Explicit `wdth` axis (skips detection; pairs with `parsedFont`). */
  wdthAxis?: WdthAxis | null;
  /** Font units per em the outlines are emitted in. Default 1000. */
  unitsPerEm?: number;
  /**
   * Variable-font instance the SVG/WebGL tiers render, in user axis units
   * (`{ wght: 700, wdth: 100, opsz: 128 }`). Default: resolved from the
   * element's computed `font-weight` / `font-stretch` / `font-style` /
   * `font-optical-sizing` / `font-variation-settings`, i.e. the same instance
   * the browser draws for that element. Pass `false` to force the font file's
   * default instance. Static fonts ignore it. (TrueType `gvar` fonts only —
   * CFF2 fonts render their default instance; see README.)
   */
  fontVariations?: Record<string, number> | false;

  /**
   * Ink match with the host's native text rasteriser. Browsers draw text a
   * fraction of a pixel bolder than its outline (Skia contrast boost; macOS
   * font smoothing), so the outline-exact WebGL/SVG tiers read lighter than the
   * text they replace. `'auto'` (default) measures the difference once per
   * font/size/colour/DPR with an offscreen canvas probe and dilates the tiers'
   * ink to match; a number forces that dilation in CSS px per edge; `0`
   * renders the exact outline. Ignored by the VF tier (native text already).
   */
  inkDilation?: 'auto' | number;

  /** Shared ticker (defaults to the library singleton). */
  ticker?: Ticker;
  /** SSR / jsdom document (defaults to the target's ownerDocument). */
  document?: Document;
  /** Reuse an AnalysisClient (defaults to a per-instance one). */
  analysisClient?: AnalysisClient;

  /** DI for capability probing (tests). */
  isReducedMotion?: () => boolean;
  isPrint?: () => boolean;
  detectWebGL2Support?: () => boolean;
  /** Injected WebGL backend (tests). */
  backend?: RenderBackend;
}

export interface Instance {
  /** Manual drive for `trigger:'custom'` (clamped to [min,max]). */
  set(value: number): void;
  /** Tear down renderer + controller; restore the DOM. Leaks nothing. */
  destroy(): void;
  /** Selected renderer tier, or null until selection completes. */
  readonly tier: ResolvedTier | null;
  /** Resolves once the renderer is attached (or the build settled/failed). */
  readonly ready: Promise<void>;
  /** Tier-selection + fall-through trail (CLAUDE.md rule 9 transparency). */
  readonly notes: readonly string[];
}
