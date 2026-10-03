/**
 * engine/variations.ts — the element's computed CSS font properties → the
 * variable-font axis request the SVG/WebGL tiers instance outlines at.
 *
 * Mirrors what the browser itself does for the same element (CSS Fonts 4 §2 +
 * §11): `font-weight` → `wght`, `font-stretch` → `wdth` (percentage), `font-style`
 * → `ital` / `slnt` (CSS oblique angles lean clockwise, `slnt` counter-clockwise,
 * hence the sign flip), `font-optical-sizing: auto` → `opsz` = font-size in CSS
 * px, and `font-variation-settings` last, overriding everything (it is the
 * lowest-level property by spec). Pure: takes any object with the computed
 * string values, so it is testable without a DOM.
 */

export interface ComputedFontStyle {
  fontWeight?: string;
  fontStretch?: string;
  fontStyle?: string;
  fontSize?: string;
  fontOpticalSizing?: string;
  fontVariationSettings?: string;
}

const STRETCH_KEYWORDS: Record<string, number> = {
  'ultra-condensed': 50,
  'extra-condensed': 62.5,
  condensed: 75,
  'semi-condensed': 87.5,
  normal: 100,
  'semi-expanded': 112.5,
  expanded: 125,
  'extra-expanded': 150,
  'ultra-expanded': 200,
};

function num(s: string | undefined): number | undefined {
  if (s == null) return undefined;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : undefined;
}

/** `font-weight` computed value → `wght` (keywords resolved). */
export function weightToWght(fontWeight: string | undefined): number | undefined {
  if (!fontWeight) return undefined;
  const s = fontWeight.trim().toLowerCase();
  if (s === 'normal') return 400;
  if (s === 'bold') return 700;
  return num(s);
}

/** `font-stretch` computed value → `wdth` percentage (keywords resolved). */
export function stretchToWdth(fontStretch: string | undefined): number | undefined {
  if (!fontStretch) return undefined;
  const s = fontStretch.trim().toLowerCase();
  if (s in STRETCH_KEYWORDS) return STRETCH_KEYWORDS[s];
  return num(s);
}

/** `font-style` computed value → `{ ital, slnt }` contributions. */
export function styleToAxes(fontStyle: string | undefined): { ital?: number; slnt?: number } {
  if (!fontStyle) return {};
  const s = fontStyle.trim().toLowerCase();
  if (s === 'italic') return { ital: 1 };
  if (s.startsWith('oblique')) {
    const deg = num(s.slice('oblique'.length));
    return { slnt: -(deg ?? 14) };
  }
  return {};
}

/** Parse `font-variation-settings` (`"wght" 700, "GRAD" 50` | `normal`). */
export function parseVariationSettings(value: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value) return out;
  const re = /["']([^"']{4})["']\s+(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) out[m[1]!] = parseFloat(m[2]!);
  return out;
}

/**
 * Resolve the axis request for an element from its computed style. Axis tags
 * the font does not have are harmless (the instancer ignores them).
 */
export function resolveVariationRequest(style: ComputedFontStyle): Record<string, number> {
  const req: Record<string, number> = {};
  const wght = weightToWght(style.fontWeight);
  if (wght != null) req.wght = wght;
  const wdth = stretchToWdth(style.fontStretch);
  if (wdth != null) req.wdth = wdth;
  Object.assign(req, styleToAxes(style.fontStyle));
  const size = num(style.fontSize);
  if (size != null && (style.fontOpticalSizing ?? 'auto') !== 'none') req.opsz = size;
  Object.assign(req, parseVariationSettings(style.fontVariationSettings));
  return req;
}
