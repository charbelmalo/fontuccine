/**
 * svg-overlay.test.ts — the shared a11y/SEO overlay contract (CLAUDE.md rule 6,
 * RESEARCH §3 invariant), exercised under jsdom.
 *
 * Verifies: real text stays in the DOM and in the accessibility tree (NOT
 * display:none / visibility:hidden), stays selectable, copy/paste text is
 * correct; the render layer is aria-hidden + pointer/selection inert; the host
 * gets containment; wrap:nowrap forces nowrap; wrap:reserve reserves MAX-ratio
 * space (default 4.5); destroy() restores the original DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createOverlay } from '../src/dom/overlay.ts';

function setup(html: string): { doc: Document; host: HTMLElement; svg: SVGElement } {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const doc = dom.window.document;
  // expose the ctor jsdom uses so `instanceof` works in the module under test
  const host = doc.querySelector('#hero') as HTMLElement;
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  return { doc, host, svg };
}

test('real text stays visible-to-a11y (not display:none / visibility:hidden), selectable', () => {
  const { doc, host, svg } = setup('<h1 id="hero">STRETCH</h1>');
  const overlay = createOverlay({ host, renderLayer: svg, document: doc, wrap: 'nowrap' });

  // text moved into a text layer but STILL present + correct
  assert.equal(host.textContent, 'STRETCH', 'copy/paste text preserved');
  assert.equal(overlay.textLayer.textContent, 'STRETCH');

  const s = overlay.textLayer.style;
  assert.notEqual(s.display, 'none', 'must NOT be display:none');
  assert.notEqual(s.visibility, 'hidden', 'must NOT be visibility:hidden');
  assert.equal(s.color, 'transparent', 'visually hidden via transparent color');
  assert.match(s.getPropertyValue('user-select'), /text/, 'stays selectable');
  assert.equal(overlay.textLayer.getAttribute('aria-hidden'), null, 'text is NOT aria-hidden');
});

test('render layer is aria-hidden + pointer/selection inert', () => {
  const { doc, host, svg } = setup('<h1 id="hero">Hi</h1>');
  createOverlay({ host, renderLayer: svg, document: doc });
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
  assert.equal(svg.style.getPropertyValue('pointer-events'), 'none');
  assert.match(svg.style.getPropertyValue('user-select'), /none/);
  assert.equal(svg.style.position, 'absolute');
});

test('host gets layout+paint containment and isolation', () => {
  const { doc, host, svg } = setup('<h1 id="hero">Hi</h1>');
  createOverlay({ host, renderLayer: svg, document: doc });
  assert.equal(host.style.contain, 'layout paint');
  assert.equal(host.style.isolation, 'isolate');
  assert.equal(host.style.position, 'relative', 'positioning context for the layer');
});

test('wrap:nowrap forces white-space:nowrap on the text layer', () => {
  const { doc, host, svg } = setup('<h1 id="hero">Long headline text</h1>');
  const overlay = createOverlay({ host, renderLayer: svg, document: doc, wrap: 'nowrap' });
  assert.equal(overlay.textLayer.style.getPropertyValue('white-space'), 'nowrap');
});

test('wrap:reserve reserves MAX-ratio width (default 4.5), not a smaller hardcoded value', () => {
  const { doc, host, svg } = setup('<h1 id="hero">WIDE</h1>');
  const overlay = createOverlay({ host, renderLayer: svg, document: doc, wrap: 'reserve' });
  // jsdom has no layout → stub the measured natural width
  const NATURAL = 200;
  overlay.textLayer.getBoundingClientRect = () => ({ width: NATURAL, height: 40, top: 0, left: 0, right: NATURAL, bottom: 40, x: 0, y: 0, toJSON() {} }) as DOMRect;
  overlay.measure();
  assert.equal(overlay.naturalWidth, NATURAL);
  assert.equal(host.style.getPropertyValue('min-width'), `${NATURAL * 4.5}px`, 'reserves configured max ratio');
});

test('wrap:reserve honors a custom maxStretchRatio', () => {
  const { doc, host, svg } = setup('<h1 id="hero">WIDE</h1>');
  const overlay = createOverlay({ host, renderLayer: svg, document: doc, wrap: 'reserve', maxStretchRatio: 3 });
  overlay.textLayer.getBoundingClientRect = () => ({ width: 100, height: 40, top: 0, left: 0, right: 100, bottom: 40, x: 0, y: 0, toJSON() {} }) as DOMRect;
  overlay.measure();
  assert.equal(host.style.getPropertyValue('min-width'), '300px');
});

function stubRect(el: { getBoundingClientRect: () => DOMRect }, width: number): void {
  el.getBoundingClientRect = () =>
    ({ width, height: 40, top: 0, left: 0, right: width, bottom: 40, x: 0, y: 0, toJSON() {} }) as DOMRect;
}

test('reserveBasis: overlay reserves naturalWidth × maxStretchRatio in BOTH modes (Tiers 1/2 coincide)', () => {
  const NATURAL = 200;
  for (const reserveBasis of ['tier-capability', 'uniform'] as const) {
    const { doc, host, svg } = setup('<h1 id="hero">WIDE</h1>');
    const overlay = createOverlay({ host, renderLayer: svg, document: doc, wrap: 'reserve', reserveBasis });
    stubRect(overlay.textLayer, NATURAL);
    overlay.measure();
    assert.equal(
      host.style.getPropertyValue('min-width'),
      '900px',
      `basis ${reserveBasis}: 200 × 4.5 = 900 regardless of basis for the overlay tiers`,
    );
  }
});

test('reserveBasis: omitted option === tier-capability for the overlay', () => {
  const NATURAL = 200;
  const a = setup('<h1 id="hero">WIDE</h1>');
  const overlayDefault = createOverlay({ host: a.host, renderLayer: a.svg, document: a.doc, wrap: 'reserve' });
  stubRect(overlayDefault.textLayer, NATURAL);
  overlayDefault.measure();

  const b = setup('<h1 id="hero">WIDE</h1>');
  const overlayExplicit = createOverlay({ host: b.host, renderLayer: b.svg, document: b.doc, wrap: 'reserve', reserveBasis: 'tier-capability' });
  stubRect(overlayExplicit.textLayer, NATURAL);
  overlayExplicit.measure();

  assert.equal(
    a.host.style.getPropertyValue('min-width'),
    b.host.style.getPropertyValue('min-width'),
    'default reserveBasis reproduces tier-capability exactly',
  );
  assert.equal(a.host.style.getPropertyValue('min-width'), '900px');
});

test('destroy() restores the original DOM and styles', () => {
  const { doc, host, svg } = setup('<h1 id="hero" class="k">STRETCH</h1>');
  const beforeStyle = host.getAttribute('style'); // null
  const overlay = createOverlay({ host, renderLayer: svg, document: doc });
  assert.ok(host.querySelector('[data-fontuccine="text"]'), 'layer added');
  overlay.destroy();
  assert.equal(host.textContent, 'STRETCH', 'text intact after destroy');
  assert.equal(host.querySelector('[data-fontuccine="text"]'), null, 'text layer removed');
  assert.equal(svg.parentNode, null, 'render layer removed');
  assert.equal(host.getAttribute('style'), beforeStyle, 'inline styles restored');
  assert.equal(svg.getAttribute('aria-hidden'), null, 'aria-hidden cleaned up');
});
