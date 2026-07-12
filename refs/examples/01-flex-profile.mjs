/**
 * 01-flex-profile.mjs — Fontuccine analysis core (reference implementation)
 *
 * Computes a per-axis "flex profile" for a glyph outline using the
 * tangent-aligned stretching method (Dave Pagurek, 2025):
 *   flex(slice) = 1                              if slice ∩ glyph = ∅
 *               = min over p in slice∩glyph of |τ̂(p) · ŝ|^k   otherwise
 * Source: https://www.davepagurek.com/programming/stretch-text/
 *
 * ⚠ LESSON RECORDED FOR IMPLEMENTERS (falsified by test-invariants.mjs):
 * A tempting "optimization" — bucketing BOUNDARY samples by axis coordinate
 * and taking per-bucket tangent minima — is NOT equivalent and fails on
 * solid strokes. A vertical slice through a solid vertical stem contains
 * boundary samples only from the distant top/bottom caps (aligned tangents
 * → wrongly stretchy); the local stroke direction is carried by the NEAREST
 * boundary to each INTERIOR point (the side walls). The interior
 * nearest-boundary-tangent field is essential. Keep it.
 *
 * Pipeline per glyph per axis (static — stretch amount is NOT an input):
 *   1. Sample outline into boundary points with unit tangents (per contour).
 *   2. For each slice across the bbox, sample interior candidate points.
 *   3. Keep points inside the glyph (even-odd raycast on sampled contours).
 *   4. Each interior point takes the tangent of its nearest boundary sample
 *      (reference: brute force; production: k-d tree / spatial hash, or a
 *      jump-flood nearest-seed pass on GPU).
 *   5. flex[slice] = min |τ̂·ŝ|^k over its interior points; empty slice → 1.
 *   6. Post-process: gaussian smoothing (cusp jank) — kept subtle so it
 *      doesn't bleed rigidity into stretch zones.
 *
 * Runs ONCE per glyph per axis in a worker. Per-frame math lives in
 * 02-lut-remap.mjs.
 *
 * Input path format (opentype.js command objects):
 *   {type:'M',x,y} {type:'L',x,y} {type:'Q',x1,y1,x,y}
 *   {type:'C',x1,y1,x2,y2,x,y} {type:'Z'}
 *
 * Production TODOs for the glyph-analysis agent:
 *   - Winding-aware filtering of samples on invisible self-intersection
 *     segments (the W in Playfair Display case).
 *   - Spatial acceleration for nearest-boundary lookup.
 *   - Arc-length-uniform (not t-uniform) boundary sampling.
 */

// ---------------------------------------------------------------- sampling

/** Evaluate point and tangent of one segment at parameter t ∈ [0,1]. */
function evalSegment(seg, t) {
  const { p0 } = seg;
  switch (seg.type) {
    case 'L': {
      const dx = seg.p1.x - p0.x, dy = seg.p1.y - p0.y;
      return { x: p0.x + t * dx, y: p0.y + t * dy, tx: dx, ty: dy };
    }
    case 'Q': {
      const { p1, p2 } = seg;
      const mt = 1 - t;
      return {
        x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
        y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
        tx: 2 * mt * (p1.x - p0.x) + 2 * t * (p2.x - p1.x),
        ty: 2 * mt * (p1.y - p0.y) + 2 * t * (p2.y - p1.y),
      };
    }
    case 'C': {
      const { p1, p2, p3 } = seg;
      const mt = 1 - t;
      return {
        x: mt ** 3 * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t ** 3 * p3.x,
        y: mt ** 3 * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t ** 3 * p3.y,
        tx: 3 * mt * mt * (p1.x - p0.x) + 6 * mt * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
        ty: 3 * mt * mt * (p1.y - p0.y) + 6 * mt * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
      };
    }
    default:
      throw new Error(`unknown segment type ${seg.type}`);
  }
}

/** Convert command list into contours of segments with explicit endpoints. */
export function commandsToContours(commands) {
  const contours = [];
  let segs = [];
  let cur = null, start = null;
  for (const c of commands) {
    switch (c.type) {
      case 'M':
        if (segs.length) { contours.push(segs); segs = []; }
        cur = { x: c.x, y: c.y }; start = cur;
        break;
      case 'L':
        segs.push({ type: 'L', p0: cur, p1: { x: c.x, y: c.y } });
        cur = { x: c.x, y: c.y };
        break;
      case 'Q':
        segs.push({ type: 'Q', p0: cur, p1: { x: c.x1, y: c.y1 }, p2: { x: c.x, y: c.y } });
        cur = { x: c.x, y: c.y };
        break;
      case 'C':
        segs.push({
          type: 'C', p0: cur,
          p1: { x: c.x1, y: c.y1 }, p2: { x: c.x2, y: c.y2 }, p3: { x: c.x, y: c.y },
        });
        cur = { x: c.x, y: c.y };
        break;
      case 'Z':
        if (cur && start && (cur.x !== start.x || cur.y !== start.y)) {
          segs.push({ type: 'L', p0: cur, p1: start });
        }
        if (segs.length) { contours.push(segs); segs = []; }
        cur = start;
        break;
    }
  }
  if (segs.length) contours.push(segs);
  return contours;
}

/**
 * Sample the outline.
 * Returns { samples, polygons }:
 *   samples:  flat [{x,y,tx,ty}] with unit tangents (for the tangent field)
 *   polygons: per-contour point rings (for even-odd point-in-glyph tests)
 */
export function sampleOutline(commands, samplesPerSegment = 24) {
  const contours = commandsToContours(commands);
  const samples = [];
  const polygons = [];
  for (const segs of contours) {
    const ring = [];
    for (const seg of segs) {
      for (let i = 0; i < samplesPerSegment; i++) { // < : avoid duplicating joints
        const t = i / samplesPerSegment;
        const s = evalSegment(seg, t);
        ring.push([s.x, s.y]);
        const len = Math.hypot(s.tx, s.ty);
        if (len < 1e-9) continue; // degenerate tangent (cusp)
        samples.push({ x: s.x, y: s.y, tx: s.tx / len, ty: s.ty / len });
      }
    }
    if (ring.length >= 3) polygons.push(ring);
  }
  return { samples, polygons };
}

// ------------------------------------------------------- geometry helpers

/** Even-odd point-in-polygon across all contours (handles counters/holes). */
export function pointInGlyph(x, y, polygons) {
  let inside = false;
  for (const ring of polygons) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Nearest boundary sample (reference: brute force — O(samples)). */
function nearestSample(x, y, samples) {
  let best = null, bestD = Infinity;
  for (const s of samples) {
    const d = (s.x - x) * (s.x - x) + (s.y - y) * (s.y - y);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

// ------------------------------------------------------------ flex profile

/**
 * Compute the flex profile along one axis.
 * @param {Object} outline  from sampleOutline(): { samples, polygons }
 * @param {Object} opts
 *   axis:        'x' → horizontal stretch (vertical slices, indexed by x)
 *                'y' → vertical stretch  (horizontal slices, indexed by y)
 *   slices:      LUT resolution (64–128 is plenty)
 *   k:           alignment sharpness. High k ≈ hard 9-slice; low k ≈ uniform.
 *   bounds:      {min,max} along the stretch axis (glyph bbox side)
 *   crossBounds: {min,max} along the perpendicular axis
 *   interiorSamples: candidate points tested per slice
 *   smooth:      gaussian sigma in slices (0 = off); kept subtle by design
 */
export function computeFlexProfile(outline, {
  axis, slices = 64, k = 8, bounds, crossBounds,
  interiorSamples = 48, smooth = 0.75,
}) {
  const { samples, polygons } = outline;
  const { min, max } = bounds;
  const span = max - min;
  if (span <= 0 || samples.length === 0) return new Float32Array(slices).fill(1);

  const cMin = crossBounds.min, cSpan = crossBounds.max - crossBounds.min;
  const flex = new Float32Array(slices).fill(1); // empty slice → fully stretchy

  for (let i = 0; i < slices; i++) {
    const a = min + ((i + 0.5) / slices) * span; // slice center on stretch axis
    let m = Infinity;
    for (let j = 0; j < interiorSamples; j++) {
      const c = cMin + ((j + 0.5) / interiorSamples) * cSpan;
      const x = axis === 'x' ? a : c;
      const y = axis === 'x' ? c : a;
      if (!pointInGlyph(x, y, polygons)) continue;
      const nb = nearestSample(x, y, samples);
      if (!nb) continue;
      const align = Math.abs(axis === 'x' ? nb.tx : nb.ty); // |τ̂ · ŝ|
      const f = Math.pow(align, k);
      if (f < m) m = f;
      if (m === 0) break;
    }
    if (Number.isFinite(m)) flex[i] = m;
  }

  return smooth > 0 ? gaussianSmooth(flex, smooth) : flex;
}

function gaussianSmooth(arr, sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(w); sum += w;
  }
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let acc = 0;
    for (let j = -radius; j <= radius; j++) {
      const idx = Math.min(arr.length - 1, Math.max(0, i + j));
      acc += arr[idx] * kernel[j + radius];
    }
    out[i] = acc / sum;
  }
  return out;
}

/** Axis-aligned bounding box of the sampled outline. */
export function sampleBounds(outline) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of outline.samples) {
    if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y;
  }
  return { minX, maxX, minY, maxY };
}
