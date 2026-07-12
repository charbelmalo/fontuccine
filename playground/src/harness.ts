/**
 * harness.ts — deterministic single-instance mode for the puppeteer matrix.
 *
 * Reached via `?harness=1&tier=…&ratio=…`. It builds ONE Fontuccine instance from
 * query params, drives it to a fixed stretch, and publishes measurements on
 * `window.__H` so the Node driver (harness/run.mjs) can make IN-RUNTIME assertions
 * (tier selection, DOM/vector geometry, VF percentage semantics, VF↔SVG parity).
 *
 * WebGL pixel-level checks (scissor↔proxy alignment, MSDF sharpness) are NOT read
 * back here: the shared context has no preserveDrawingBuffer, so an in-page pixel
 * read isn't reliable. Those are captured as full-page screenshots for the driver
 * to save as BY-INSPECTION artifacts. The full-viewport shared canvas overlays the
 * host 1:1, so the screenshot shows exactly what shipped.
 */
import { Fontuccine } from 'fontuccine';
import type { FontuccineConfig } from 'fontuccine';

export interface HarnessAPI {
  ready: boolean;
  scenario: string;
  requestedTier: string;
  resolvedTier: string | null;
  notes: string[];
  set(v: number): void;
  /** Ink bounding box in CSS px relative to the host's top-left, tier-aware. */
  ink(): { x: number; y: number; w: number; h: number } | null;
  host(): { w: number; h: number };
  /** Tier-0 only: the applied width in CSS % + font-variation-settings string. */
  vf(): { fontStretch: string; fvs: string } | null;
  /** Count of drawn glyph vectors (SVG) — proves per-glyph split rendering. */
  glyphPaths(): number;
  webglCanvas(): { present: boolean; w: number; h: number } | null;
}

declare global {
  interface Window { __H?: HarnessAPI; }
}

function unionRect(host: HTMLElement, nodes: Element[]): { x: number; y: number; w: number; h: number } | null {
  if (!nodes.length) return null;
  const hb = host.getBoundingClientRect();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    const r = (n as HTMLElement).getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top);
    x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
  }
  if (!Number.isFinite(x0)) return null;
  return { x: x0 - hb.left, y: y0 - hb.top, w: x1 - x0, h: y1 - y0 };
}

export async function mountHarness(params: URLSearchParams, fontTtf: string): Promise<void> {
  document.body.innerHTML =
    '<main style="padding:40px;background:#fff;color:#000;min-height:100vh">' +
    '<h1 id="hero" style="font-size:96px;font-weight:700;white-space:nowrap;margin:0;' +
    "font-family:'Roboto Flex VF',sans-serif\">HARNESS</h1></main>";

  const host = document.getElementById('hero') as HTMLElement;
  const tier = (params.get('tier') ?? 'auto') as FontuccineConfig['tier'];
  const ratio = parseFloat(params.get('ratio') ?? '2.5');
  const text = params.get('text') ?? 'Ho';
  const rm = params.get('rm') === '1';
  const wrap = (params.get('wrap') ?? 'nowrap') as FontuccineConfig['wrap'];
  host.textContent = text;

  const config: FontuccineConfig = {
    tier,
    trigger: 'custom',
    text,
    fontUrl: fontTtf,
    // `maxr` lets a scenario keep the range inside a font's wdth axis (VF is only
    // taken when the requested range fits the designed axis — see vf/probe.ts).
    maxStretchRatio: params.get('maxr') ? parseFloat(params.get('maxr')) : Math.max(ratio, 3),
    minStretchRatio: 1,
    wrap,
    respectReducedMotion: rm ? true : false,
    isReducedMotion: () => rm,
    physics: { stiffness: 400, damping: 40 },
  };

  const api: HarnessAPI = {
    ready: false,
    scenario: params.get('harness') ?? '1',
    requestedTier: tier ?? 'auto',
    resolvedTier: null,
    notes: [],
    set: () => {},
    ink() {
      // SVG tier: union of glyph <path> boxes.
      const svg = host.querySelector('svg[data-fontuccine="svg-tier"]');
      if (svg) return unionRect(host, [...svg.querySelectorAll('path')]);
      // WebGL proxy geometry (pixels are by-inspection).
      const proxy = host.querySelector('[data-fontuccine="webgl"]');
      if (proxy) return unionRect(host, [proxy]);
      // VF tier: the native text itself, measured via a Range over the text run.
      const rg = document.createRange();
      rg.selectNodeContents(host);
      const r = rg.getBoundingClientRect();
      const hb = host.getBoundingClientRect();
      rg.detach?.();
      if (r.width === 0 && r.height === 0) return unionRect(host, [host]);
      return { x: r.left - hb.left, y: r.top - hb.top, w: r.width, h: r.height };
    },
    host() { const r = host.getBoundingClientRect(); return { w: r.width, h: r.height }; },
    vf() {
      const cs = getComputedStyle(host);
      return { fontStretch: cs.fontStretch, fvs: cs.fontVariationSettings };
    },
    glyphPaths() {
      const svg = host.querySelector('svg[data-fontuccine="svg-tier"]');
      return svg ? svg.querySelectorAll('path').length : 0;
    },
    webglCanvas() {
      const c = document.querySelector('canvas[data-fontuccine="webgl-shared"]') as HTMLCanvasElement | null;
      return c ? { present: true, w: c.width, h: c.height } : { present: false, w: 0, h: 0 };
    },
  };
  window.__H = api;

  // Ensure the VF @font-face is actually loaded before measuring the VF tier.
  try { await (document as unknown as { fonts: FontFaceSet }).fonts.load("96px 'Roboto Flex VF'"); } catch { /* no-op */ }

  const inst = Fontuccine.attach(host, config);
  api.set = (v: number) => inst.set(v);
  await inst.ready;
  api.resolvedTier = inst.tier;
  api.notes = [...inst.notes];
  inst.set(ratio);

  // Let the spring settle + paint a couple of frames before we flag ready.
  await new Promise((r) => setTimeout(r, 180));
  api.ready = true;
  document.title = `harness:${api.resolvedTier}`;
}
