#version 300 es
// 04-msdf-stretch.frag.glsl — Fontuccine Tier-1 fragment shader (WebGL2)
//
// Standard MSDF rendering (median of 3 channels + screen-space AA via
// fwidth) plus the optional post-fx the RFC calls for. Because vertices
// were remapped in the vertex stage, no UV math is needed here — fwidth()
// automatically widens the AA band where geometry was stretched, keeping
// edges crisp and consistent.
//
// References: msdfgen (Chlumsky), awesome-msdf shader notes.

precision highp float;

in vec2 v_atlasUV;
out vec4 fragColor;

uniform sampler2D u_msdfAtlas;
uniform vec4  u_color;
uniform float u_pxRange;      // msdf distance range in atlas px (msdfgen param)
uniform vec2  u_atlasSize;

// Post-fx (all optional; branchless when intensity = 0)
uniform float u_grainIntensity;   // 0..1
uniform float u_aberration;       // px offset at stretch axis, ∝ velocity
uniform vec2  u_stretchDir;       // unit vector of active stretch axis
uniform float u_time;

float median3(vec3 v) { return max(min(v.r, v.g), min(max(v.r, v.g), v.b)); }

float sampleSD(vec2 uv) {
  vec3 msd = texture(u_msdfAtlas, uv).rgb;
  return median3(msd) - 0.5;
}

// cheap hash noise for film grain
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7)) + u_time) * 43758.5453);
}

void main() {
  // screenPxDistance: how many screen px per distance-field unit here.
  vec2 unitRange = vec2(u_pxRange) / u_atlasSize;
  vec2 screenTexSize = vec2(1.0) / fwidth(v_atlasUV);
  float screenPxRange = max(0.5 * dot(unitRange, screenTexSize), 1.0);

  float alpha;
  if (u_aberration > 0.001) {
    // chromatic aberration: split channels along the stretch direction
    vec2 off = u_stretchDir * u_aberration / u_atlasSize;
    float r = clamp(sampleSD(v_atlasUV - off) * screenPxRange + 0.5, 0.0, 1.0);
    float g = clamp(sampleSD(v_atlasUV)        * screenPxRange + 0.5, 0.0, 1.0);
    float b = clamp(sampleSD(v_atlasUV + off) * screenPxRange + 0.5, 0.0, 1.0);
    fragColor = vec4(u_color.rgb * vec3(r, g, b), max(max(r, g), b) * u_color.a);
    alpha = fragColor.a;
  } else {
    alpha = clamp(sampleSD(v_atlasUV) * screenPxRange + 0.5, 0.0, 1.0);
    fragColor = vec4(u_color.rgb, alpha * u_color.a);
  }

  if (u_grainIntensity > 0.001 && alpha > 0.0) {
    float g = (hash(gl_FragCoord.xy) - 0.5) * u_grainIntensity;
    fragColor.rgb += g * alpha;
  }
}

// Implementation notes for the gpu-render agent:
// - Displacement maps (RFC "tv-noise" option): add a small UV offset BEFORE
//   sampleSD from a noise texture: uv += texture(u_noise, uv*scale+t).rg *
//   intensity/atlasSize. Distance-field sampling keeps edges continuous.
// - Premultiplied alpha + ONE, ONE_MINUS_SRC_ALPHA blending for correct
//   compositing over the page.
// - For very large on-screen sizes consider supersampled MSDF variant or
//   two-sample AA (see awesome-msdf artifacts section).
