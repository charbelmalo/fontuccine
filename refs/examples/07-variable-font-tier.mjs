/**
 * 07-variable-font-tier.mjs — Fontuccine Tier-0 (variable font `wdth`)
 *
 * Opportunistic cheapest tier: when the active font is a variable font with
 * a `wdth` axis AND the requested stretch fits the axis range, map the
 * interaction value straight to `font-stretch` (CSS Fonts 4 percentage —
 * preferred over font-variation-settings because it composes with the
 * font-matching algorithm; MDN Variable Fonts guide).
 *
 * ⚠ Verified perf reality (RESEARCH.md §2): this is NOT compositor
 * accelerated. Changing wdth re-layouts + repaints the text on the main
 * thread every frame. That is fine for ONE headline; it is the reason this
 * tier is a fallback, not the default. Claims of "zero overhead" in the
 * original RFC were wrong.
 *
 * Axis detection: parse the `fvar` table (we already have the font binary
 * in the analysis worker for other tiers) — no rendering heuristics needed.
 */

/** From an opentype.js font object: {min, default, max} for wdth, or null. */
export function getWdthAxis(otFont) {
  const axes = otFont?.tables?.fvar?.axes;
  if (!axes) return null;
  const wdth = axes.find((a) => a.tag === 'wdth');
  return wdth ? { min: wdth.minValue, def: wdth.defaultValue, max: wdth.maxValue } : null;
}

/** Can this tier honor the config? (stretch is a ratio; wdth is % of normal) */
export function tierSupports(axis, cfg) {
  if (!axis) return false;
  const maxRatio = axis.max / 100, minRatio = axis.min / 100;
  return cfg.maxStretchRatio <= maxRatio && (cfg.minStretchRatio ?? 1) >= minRatio
    && cfg.axis === 'horizontal'; // wdth is horizontal-only by definition
}

/** Per-frame application (RENDER phase of the shared ticker only). */
export function applyStretch(el, ratio, axis) {
  const pct = Math.max(axis.min, Math.min(axis.max, ratio * 100));
  el.style.fontStretch = `${pct}%`;
}

/*
 * Notes for the dom-render agent:
 * - Vertical stretch has no registered axis; some fonts expose custom axes
 *   (e.g. 'YTUC','YTLC' in parametric fonts) — detect and map when present,
 *   else this tier declines and the engine picks SVG/WebGL.
 * - Advance widths change per frame → layout shift of following content.
 *   Engine default `white-space: nowrap` + reserved max width (cfg
 *   reserveSpace) applies to this tier especially (RESEARCH.md risk #1).
 * - Feature-detect once: CSS.supports('font-stretch', '150%').
 */
