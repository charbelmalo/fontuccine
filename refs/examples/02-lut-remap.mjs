/**
 * 02-lut-remap.mjs — Fontuccine shared remap core (reference implementation)
 *
 * Turns a flex profile (static, per glyph) + a stretch ratio (dynamic, per
 * frame) into a monotonic 1D coordinate remap. This is the ONLY math that
 * runs per frame, and it is identical across all three render tiers:
 *   - SVG tier: remap() applied to outline points on the CPU
 *   - WebGL tier: toNormalizedLUT() uploaded as an Nx1 texture, sampled in
 *     the vertex (position) and/or fragment (UV) shader
 *   - Flexbox analogy: slice i receives extra space E · fᵢ / Σf
 *
 * Compression guard (stretch < 1): rigid slices must never invert. We clamp
 * each slice's shrink to 99.9% of its width and redistribute the deficit
 * over slices that still have capacity (few-pass water-filling).
 */

/**
 * @param {Float32Array|number[]} flex  per-slice flex weights (0..1)
 * @param {Object} opts
 *   min, max: original glyph bounds along the axis
 *   stretch:  target ratio (1 = identity, 2 = double, 0.5 = half)
 * @returns remap object
 */
export function buildRemap(flex, { min, max, stretch }) {
  const N = flex.length;
  const W = max - min;
  const w = W / N;                    // original slice width
  const E = W * (stretch - 1);        // total extra space (negative = compress)

  let sumF = 0;
  for (let i = 0; i < N; i++) sumF += flex[i];

  // Per-slice extra space
  const e = new Float64Array(N);
  if (sumF < 1e-9) {
    // Fully rigid glyph: degrade to uniform scaling (matches Pagurek's
    // observation that letters with no aligned segments stretch uniformly).
    for (let i = 0; i < N; i++) e[i] = E / N;
  } else {
    for (let i = 0; i < N; i++) e[i] = (E * flex[i]) / sumF;
  }

  // Compression guard: no slice may shrink below 0.1% of its width.
  if (E < 0) {
    const floor = -w * 0.999;
    for (let pass = 0; pass < 4; pass++) {
      let deficit = 0, capacity = 0;
      for (let i = 0; i < N; i++) {
        if (e[i] < floor) { deficit += e[i] - floor; e[i] = floor; }
        else if (e[i] > floor) capacity += flex[i];
      }
      if (deficit === 0 || capacity < 1e-9) break;
      for (let i = 0; i < N; i++) {
        if (e[i] > floor) e[i] += (deficit * flex[i]) / capacity;
      }
    }
  }

  // Cumulative slice boundaries. Origin stays anchored at `min`;
  // alignment (center/right growth) is the renderer's concern.
  const b = new Float64Array(N + 1);
  b[0] = min;
  for (let i = 0; i < N; i++) b[i + 1] = b[i] + w + e[i];

  /** Map an original axis coordinate to its stretched position. */
  function remap(x) {
    const u = (x - min) / W;                 // normalized 0..1
    if (u <= 0) return b[0] + u * (w + e[0]) * N; // linear extrapolation
    if (u >= 1) return b[N] + (u - 1) * (w + e[N - 1]) * N;
    const f = u * N;
    const i = Math.min(N - 1, Math.floor(f));
    const t = f - i;
    return b[i] + t * (w + e[i]);
  }

  /**
   * Normalized cumulative LUT for GPU upload: lut[i] = position of boundary
   * i as a 0..1 fraction of the FINAL (stretched) extent. Shader usage:
   *   float remapped = mix(lut[i], lut[i+1], fract(u * N));  // u = original 0..1
   * Store as R32F (or pack to RGBA8) Nx1 texture, LINEAR filtering.
   */
  function toNormalizedLUT() {
    const total = b[N] - b[0];
    const lut = new Float32Array(N + 1);
    for (let i = 0; i <= N; i++) lut[i] = total === 0 ? i / N : (b[i] - b[0]) / total;
    return lut;
  }

  return { remap, boundaries: b, extras: e, sliceWidth: w, toNormalizedLUT };
}
