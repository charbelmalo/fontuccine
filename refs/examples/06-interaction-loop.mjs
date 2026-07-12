/**
 * 06-interaction-loop.mjs — Fontuccine event/ticker architecture (reference)
 *
 * Design rules (from motion.dev tier-list + Lenis integration findings):
 *  R1  ONE rAF loop for the whole library (never per element/instance).
 *  R2  Strict phase ordering per frame: READ → UPDATE → RENDER. All DOM
 *      measurements in READ, all DOM/GL writes in RENDER → zero thrashing.
 *  R3  Never read layout in scroll/pointer handlers — handlers only record
 *      raw input; derivation happens in the frame.
 *  R4  Rects are cached and invalidated by ResizeObserver + scroll delta —
 *      no per-frame getBoundingClientRect.
 *  R5  IntersectionObserver gates instances: offscreen ⇒ fully idle.
 *  R6  Springs (critically damped) smooth stimulus → stretch so abrupt
 *      input (hover on/off) still animates like motion design.
 *  R7  prefers-reduced-motion ⇒ stimuli clamp to their resting value.
 *  R8  External driver support: ticker.drive(fn) lets GSAP/Lenis own the
 *      rAF (gsap.ticker.add(t => fontuccine.tick(t))), per Lenis docs.
 */

// ------------------------------------------------------------------ ticker
export const ticker = (() => {
  const reads = new Set(), updates = new Set(), renders = new Set();
  let running = false, external = false, rafId = 0;

  function frame(now) {
    for (const f of reads) f(now);     // measure (getBoundingClientRect etc.)
    for (const f of updates) f(now);   // pure math (springs, LUT rebuilds)
    for (const f of renders) f(now);   // write (GL draw / d attr / style)
    if (running && !external) rafId = requestAnimationFrame(frame);
  }
  function start() {
    if (!running) { running = true; if (!external) rafId = requestAnimationFrame(frame); }
  }
  function stop() { running = false; cancelAnimationFrame(rafId); }
  return {
    read: (f) => (reads.add(f), start(), () => reads.delete(f)),
    update: (f) => (updates.add(f), start(), () => updates.delete(f)),
    render: (f) => (renders.add(f), start(), () => renders.delete(f)),
    /** hand the loop to an external driver (GSAP ticker, Lenis raf) */
    drive() { external = true; stop(); running = true; return frame; },
    stop,
  };
})();

// ------------------------------------------------------- stimulus: scroll
/** Scroll velocity in px/s, exponentially smoothed, handler does NO layout reads. */
export function createScrollStimulus({ smoothing = 0.12 } = {}) {
  let lastY = window.scrollY, lastT = performance.now();
  let raw = 0, value = 0;
  const onScroll = () => {
    const now = performance.now();
    const y = window.scrollY;                 // scroll offset read is cheap;
    const dt = Math.max(1, now - lastT);      // no layout is forced here
    raw = ((y - lastY) / dt) * 1000;
    lastY = y; lastT = now;
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  const unsub = ticker.update(() => {
    value += (raw - value) * smoothing;
    raw *= 0.86; // decay toward 0 when scrolling stops
  });
  return { get value() { return value; }, destroy() { unsub(); window.removeEventListener('scroll', onScroll); } };
}

// ------------------------------------------------------ stimulus: pointer
/** Proximity 0..1 to an element, using cached rects (R4). */
export function createProximityStimulus(el, { radius = 240 } = {}) {
  let px = -1e6, py = -1e6, rect = null, value = 0;
  const measure = () => { rect = el.getBoundingClientRect(); };
  const ro = new ResizeObserver(() => ticker.read(function once() { measure(); })());
  ro.observe(el);
  window.addEventListener('scroll', () => { rect = null; }, { passive: true });
  const onMove = (e) => { px = e.clientX; py = e.clientY; };
  window.addEventListener('pointermove', onMove, { passive: true });

  const unsubRead = ticker.read(() => { if (!rect) measure(); });
  const unsubUpdate = ticker.update(() => {
    if (!rect) return;
    const cx = Math.max(rect.left, Math.min(px, rect.right));
    const cy = Math.max(rect.top, Math.min(py, rect.bottom));
    const d = Math.hypot(px - cx, py - cy);
    value = Math.max(0, 1 - d / radius);
  });
  return {
    get value() { return value; },
    destroy() { unsubRead(); unsubUpdate(); ro.disconnect(); window.removeEventListener('pointermove', onMove); },
  };
}

// ------------------------------------------------------------------ spring
/** Critically damped spring — no overshoot unless configured, frame-rate independent. */
export function createSpring({ stiffness = 170, damping = 26, initial = 0 } = {}) {
  let x = initial, v = 0, target = initial, lastT = 0;
  const unsub = ticker.update((now) => {
    const dt = Math.min(0.064, lastT ? (now - lastT) / 1000 : 1 / 60);
    lastT = now;
    const a = -stiffness * (x - target) - damping * v;
    v += a * dt;
    x += v * dt;
  });
  return {
    set(t) { target = t; },
    get value() { return x; },
    destroy: unsub,
  };
}

// ------------------------------------------------------------- reduced motion
export const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/*
 * Wiring sketch (what Fontuccine.attach does):
 *
 *   const scroll = createScrollStimulus();
 *   const spring = createSpring({ stiffness: 140, damping: 22, initial: 1 });
 *   ticker.update(() => {
 *     const target = prefersReducedMotion() ? 1
 *       : 1 + Math.min(cfg.maxStretchRatio - 1,
 *                      Math.abs(scroll.value) * cfg.velocityToStretch);
 *     spring.set(target);
 *   });
 *   ticker.render(() => renderer.draw(spring.value)); // GL draw or d-attr write
 *
 * IntersectionObserver gating (R5): when the element leaves the viewport,
 * destroy/suspend its update+render subscriptions; recreate on re-entry.
 */
