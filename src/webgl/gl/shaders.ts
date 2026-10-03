/**
 * webgl/gl/shaders.ts — Tier-1 GLSL ES 3.00 program source.
 *
 * Derived from refs/examples/03 (vertex) + 04 (fragment). Two DELIBERATE changes
 * from 03, both required by this tier's obligations (flagged in the report):
 *   1. STRETCH-INDEPENDENT LUT: the texture stores normalized cumulative FLEX
 *      C(u); the ratio is applied via `u_stretch` so nothing is re-uploaded per
 *      frame (parity.ts explains the algebra & exactness envelope). This keeps
 *      the locked "remap through a cumulative LUT texture; UVs original" design.
 *   2. INSTANCED, static per-glyph attributes + a per-glyph LUT ROW packed into
 *      ONE texture, so a whole run draws with zero rebinds and zero per-frame
 *      buffer uploads — only `u_stretch`/`u_origin` (+ effect scalars) change.
 *
 *   3. TWO DESIGN INSTANCES per glyph (core/width-plan.ts): every instance
 *      carries the ink box + atlas rect of two neighbouring variable-font
 *      instances; `u_instMix` blends their geometry in the vertex stage and
 *      their distance fields in the fragment stage (same normalized box
 *      coordinate in both fields ⇒ the outline blend, while edges move less
 *      than the field range — engine/width-ladder.ts bounds that). The
 *      residual widening is `u_growth · (leftSlope + inkSlope · C(u))` with C
 *      the cumulative STRAIGHT-column weights, so diagonals never widen.
 *      The legacy flex model is the special case L0 = L1, u_instMix = 0,
 *      u_growth = stretch − 1, leftSlope = origin, inkSlope = width, C = flex.
 *
 * The LUT is sampled with an explicit two-tap texelFetch `mix()` (not hardware
 * LINEAR) so we never depend on OES_texture_float_linear for R32F.
 *
 * Post-fx (fragment) are branchless when their intensity is 0 (obligation 3):
 * grain, chromatic aberration (∝ velocity, along the stretch axis), and a
 * displacement noise-texture UV warp. Output is PREMULTIPLIED alpha for correct
 * compositing over arbitrary page backgrounds (obligation 2).
 */

export const VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;

// Shared subdivided-quad grid (slice-grid.ts): box coords in [0,1]^2.
in vec2 a_boxCoord;

// Instanced, STATIC per-glyph attributes (uploaded per instance pair; never per frame).
in vec2  a_left;          // ink left (px from run origin) in instance 0 / instance 1
in vec2  a_width;         // ink width (px) in instance 0 / instance 1
in vec2  a_y0;            // instance 0 (yTop_px from run top, height_px), SVG-down
in vec2  a_y1;            // instance 1 (yTop_px, height_px)
in vec4  a_uv0;           // instance 0 atlas rect: UV at box (0,0) + UV delta across the box
in vec4  a_uv1;           // instance 1 atlas rect
in float a_lutRow;        // this glyph's row in the packed LUT texture
in vec2  a_slopes;        // residual px per unit growth: (left edge, ink width)
in vec4  a_quad;          // (padLeft, padRight, padTop, padBottom) beyond the ink box, ink units

uniform sampler2D u_lut;      // R32F, (N+1) x glyphCount, NEAREST; holds C(u)
uniform ivec2 u_lutSize;      // (N+1, glyphCount)
uniform float u_growth;       // residual growth (legacy model: stretch - 1)
uniform float u_instMix;      // blend instance 0 -> 1
uniform float u_origin;       // run origin in device px
uniform vec2  u_viewport;     // device px viewport (for clip mapping)

out vec2 v_atlasUV;
out vec2 v_atlasUV1;

// Two-tap linear sample of the cumulative-flex LUT at normalized u for this row.
float sampleCumFlex(float u, int row) {
  int N = u_lutSize.x - 1;              // boundary count
  float f = clamp(u, 0.0, 1.0) * float(N);
  int i = int(floor(f));
  i = min(i, N - 1);
  float t = f - float(i);
  float a = texelFetch(u_lut, ivec2(i, row), 0).r;
  float b = texelFetch(u_lut, ivec2(i + 1, row), 0).r;
  return mix(a, b, t);
}

void main() {
  // Interior grid columns sit exactly on the LUT slice boundaries (u in [0,1] of
  // the INK box). The two outermost columns / the two rows are pushed out over
  // the bitmap padding so the quad also carries the anti-aliasing ramp; there
  // C(u) is constant (0 or 1), so the extension is an exact linear continuation.
  float bx = a_boxCoord.x;
  float by = a_boxCoord.y;
  float uOrig = bx <= 0.0 ? -a_quad.x : (bx >= 1.0 ? 1.0 + a_quad.y : bx);
  float vOrig = by <= 0.0 ? -a_quad.z : (by >= 1.0 ? 1.0 + a_quad.w : by);
  float C = sampleCumFlex(uOrig, int(a_lutRow + 0.5));

  // Instance blend (identity when a_left.x == a_left.y etc.), then the residual:
  // the left edge moves by growth*leftSlope, the ink widens only where C rises.
  float inkLeft = u_origin + mix(a_left.x, a_left.y, u_instMix);
  float width = mix(a_width.x, a_width.y, u_instMix);
  float posX = inkLeft + width * uOrig + u_growth * (a_slopes.x + a_slopes.y * C);
  // Glyph geometry is SVG-down (y increases downward, like the SVG tier): box y=0
  // is the glyph's visual top (bbox.minY), box y=1 its visual bottom (bbox.maxY).
  vec2 gy = mix(a_y0, a_y1, u_instMix);
  float posY = gy.x + vOrig * gy.y;

  v_atlasUV = a_uv0.xy + vec2(uOrig, vOrig) * a_uv0.zw;
  v_atlasUV1 = a_uv1.xy + vec2(uOrig, vOrig) * a_uv1.zw;

  vec2 clip = vec2(posX / u_viewport.x * 2.0 - 1.0, 1.0 - posY / u_viewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_atlasUV;
in vec2 v_atlasUV1;
out vec4 fragColor;

uniform sampler2D u_msdfAtlas;
uniform vec4  u_color;         // straight-alpha ink color
uniform float u_pxRange;       // msdf distance range in atlas texels
uniform vec2  u_atlasSize;     // atlas texture size (texels)

// Post-fx (all optional; each is a no-op branch when its scalar is ~0).
uniform float u_grainIntensity;   // 0..1 film grain
uniform float u_aberration;       // channel split (px), ∝ velocity
uniform float u_inkDilate;        // extra ink per edge (device px) — matches the native text rasteriser
uniform vec2  u_stretchDir;       // unit vector of the active stretch axis
uniform float u_time;
uniform float u_dispIntensity;    // displacement warp strength (px)
uniform vec2  u_dispScale;        // noise sampling scale
uniform sampler2D u_noise;        // displacement noise texture
uniform int   u_hasNoise;         // 1 when a displacement texture is bound
uniform float u_instMix;          // blend of the two instances' distance fields

float median3(vec3 v) { return max(min(v.r, v.g), min(max(v.r, v.g), v.b)); }
// Instance 1's field is sampled at the same box coordinate (offset carried over).
vec2 g_uvDelta;
float sampleSD(vec2 uv) {
  float d0 = median3(texture(u_msdfAtlas, uv).rgb) - 0.5;
  if (u_instMix <= 0.0) return d0;
  float d1 = median3(texture(u_msdfAtlas, uv + g_uvDelta).rgb) - 0.5;
  return mix(d0, d1, u_instMix);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + u_time) * 43758.5453); }

void main() {
  vec2 uv = v_atlasUV;
  g_uvDelta = v_atlasUV1 - v_atlasUV;

  // Displacement: warp the sampling UV by a noise texture BEFORE distance
  // sampling — the distance field stays continuous so edges do not tear.
  if (u_dispIntensity > 0.001 && u_hasNoise == 1) {
    vec2 n = texture(u_noise, uv * u_dispScale + u_time * 0.05).rg - 0.5;
    uv += n * (u_dispIntensity / u_atlasSize);
  }

  vec2 unitRange = vec2(u_pxRange) / u_atlasSize;
  vec2 screenTexSize = vec2(1.0) / fwidth(uv);
  float screenPxRange = max(0.5 * dot(unitRange, screenTexSize), 1.0);

  float alpha;
  if (u_aberration > 0.001) {
    // Chromatic aberration: split channels along the stretch axis.
    vec2 off = u_stretchDir * u_aberration / u_atlasSize;
    float r = clamp(sampleSD(uv - off) * screenPxRange + 0.5 + u_inkDilate, 0.0, 1.0);
    float g = clamp(sampleSD(uv)       * screenPxRange + 0.5 + u_inkDilate, 0.0, 1.0);
    float b = clamp(sampleSD(uv + off) * screenPxRange + 0.5 + u_inkDilate, 0.0, 1.0);
    float a = max(max(r, g), b) * u_color.a;
    // premultiplied output
    fragColor = vec4(u_color.rgb * vec3(r, g, b) * u_color.a, a);
    alpha = a;
  } else {
    float d = clamp(sampleSD(uv) * screenPxRange + 0.5 + u_inkDilate, 0.0, 1.0);
    alpha = d * u_color.a;
    fragColor = vec4(u_color.rgb * alpha, alpha); // premultiplied
  }

  if (u_grainIntensity > 0.001 && alpha > 0.0) {
    float g = (hash(gl_FragCoord.xy) - 0.5) * u_grainIntensity;
    fragColor.rgb += g * alpha; // stays premultiplied (scaled by coverage)
  }
}
`;
