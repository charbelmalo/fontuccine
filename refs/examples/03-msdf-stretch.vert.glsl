#version 300 es
// 03-msdf-stretch.vert.glsl — Fontuccine Tier-1 vertex shader (WebGL2)
//
// Geometry: one quad PER GLYPH, subdivided into a (LUT_SIZE × 1) column grid
// horizontally and/or (1 × LUT_SIZE) rows vertically (match grid to LUT
// resolution so the piecewise-linear remap is exact at texel boundaries).
//
// The stretch happens by MOVING VERTICES through the cumulative flex LUT;
// UVs stay original, so the MSDF texels stretch with the geometry and the
// fragment shader re-thresholds → edges stay crisp at any ratio.
//
// LUT encoding (see 02-lut-remap.mjs → toNormalizedLUT):
//   R32F (or RGBA8-packed) texture, width = N+1, height = 1
//   lut[i] = normalized stretched position of original boundary i/N.
//   Sampled with LINEAR filtering ⇒ texture(u_lut, u) IS the remap.

precision highp float;

// Per-vertex: normalized position within the glyph box [0..1]²
in vec2 a_boxCoord;
// Per-vertex: MSDF atlas UV for this corner (original, never remapped)
in vec2 a_atlasUV;

// Per-glyph (instanced attributes or UBO)
in vec4 a_glyphRect;   // xy = origin (px, layout space), zw = w,h unstretched

uniform sampler2D u_lutX;    // horizontal cumulative LUT for this glyph
uniform sampler2D u_lutY;    // vertical cumulative LUT for this glyph
uniform vec2  u_stretch;     // (sx, sy) current ratios, 1.0 = identity
uniform vec2  u_axisEnable;  // 1/0 flags: horizontal, vertical
uniform mat4  u_projection;  // layout px → clip space

out vec2 v_atlasUV;

float remapAxis(sampler2D lut, float u, float enabled) {
  // texture() with LINEAR filtering interpolates between LUT boundaries,
  // which is exactly the piecewise-linear cumulative remap.
  float remapped = texture(lut, vec2(u, 0.5)).r;
  return mix(u, remapped, enabled);
}

void main() {
  float u = remapAxis(u_lutX, a_boxCoord.x, u_axisEnable.x);
  float v = remapAxis(u_lutY, a_boxCoord.y, u_axisEnable.y);

  // Scale glyph box by the stretch ratio; remapped coords distribute it.
  vec2 size = a_glyphRect.zw * mix(vec2(1.0), u_stretch, u_axisEnable);
  vec2 pos  = a_glyphRect.xy + vec2(u, v) * size;

  v_atlasUV = a_atlasUV;
  gl_Position = u_projection * vec4(pos, 0.0, 1.0);
}

// Implementation notes for the gpu-render agent:
// - Per-glyph LUTs: pack all glyphs' LUTs into ONE texture array / atlas row
//   per glyph, pass row index as an instanced attribute — avoids rebinds.
// - Advances: the interaction engine recomputes pen positions per frame from
//   each glyph's stretched advance (Σ LUT extent); kerning applied in
//   stretched space (see RESEARCH.md risk #6).
// - WebGPU port: identical logic in WGSL; LUT as storage buffer instead of
//   texture if preferred.
