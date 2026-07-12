# Fontuccine — R&D Findings & Pipeline Decision

Date: 2026-07-11 · Status: **Decision approved (Hybrid, WebGL-first)** · Author: research phase, pre-implementation

This document is the output of the front-loaded research phase. It corrects several claims in the intern RFC, identifies the mathematical core we should adopt instead of inventing one, benchmarks the three candidate pipelines against verified browser-rendering facts, and records the approved architecture.

---

## 1. The single most important finding

The problem described in the RFC — "stretch a glyph while protecting caps, serifs and curve geometry, for *any* font, algorithmically" — has already been solved and published, with open-source code:

**Dave Pagurek, "Tall Tales: Tangent-Aligned Text Stretching" (Sept 2025)**
https://www.davepagurek.com/programming/stretch-text/ · code: https://openprocessing.org/sketch/2716638

His method generalizes 9-slice scaling to its continuous limit. For each axis, every slice (column or row) of a glyph's bounding box gets a *flex weight*:

```
f(L; G, s, k) = 1                            if the slice L doesn't intersect glyph G
              = min over x in L∩G of |τ(x)·s|^k    otherwise
```

where `τ(x)` is the outline tangent at a boundary sample, `s` is the unit stretch direction, and `k` sharpens the falloff (high k → hard 9-slice behaviour, low k → near-uniform stretch). Slices whose outline runs parallel to the stretch direction (the middle of an H's crossbar, the straight flanks of an O) absorb the stretch; slices containing perpendicular strokes or serifs (flex → 0) stay rigid. Extra space is distributed like CSS flexbox: slice *i* gains `E · fᵢ / Σf`.

Why this matters strategically:

- It is exactly the After Effects methodology from the RFC (isolate straight segments, protect curves/serifs, translate interior geometry) — but expressed as a closed-form weight function instead of manual anchor-point work, so it applies to **any outline font automatically** (he demos it across Google Fonts).
- It collapses the per-frame problem to almost nothing. The tangent analysis is **static per glyph** — it does not depend on the stretch amount. So we compute it once (in a worker), reduce it to a **1D cumulative remap LUT per axis**, and the per-frame operation is a monotonic table lookup. That LUT is equally consumable by a vertex/fragment shader (as an Nx1 texture), by SVG path point remapping, or by Canvas2D.
- His "future work" section lists exactly the gaps a production package should close: smoothing at cusps, first/last-slice bend, self-intersecting outlines (W in Playfair Display), and a GPU implementation. That is our roadmap, not our risk.

**Decision: adopt tangent-aligned flex profiles as Fontuccine's mathematical core.** We do not invent new deformation math; we productionize this.

### 1.1 A tempting simplification, falsified by our tests

We initially hypothesized that Pagurek's interior-point + k-d-tree tangent lookup could be replaced by simply bucketing *boundary* samples by their axis coordinate and min-reducing per bucket. **Our invariant tests disproved this**: a solid vertical stem under horizontal stretch reads only the distant top/bottom caps' aligned tangents in its interior columns (the rigid side walls occupy just the outermost buckets), so the stem wrongly stretched ~3× instead of staying rigid.

The essential mechanism is that each *interior* point takes the tangent of its **nearest boundary point** — that is what encodes local stroke direction (a mid-stem point is nearest to the side walls → perpendicular → rigid; a mid-crossbar point is nearest to the bar's top/bottom edges → aligned → stretchy). The reference implementation (`refs/examples/01-flex-profile.mjs`) now does this faithfully: interior sampling per slice, even-odd point-in-glyph test, nearest-boundary tangent, min-reduce, gaussian smoothing. All 17 invariants pass (`refs/examples/test-invariants.mjs`), including stroke preservation, stretch localization, compression non-inversion, and the uniform-degradation case for stroke-only glyphs. Production accelerates nearest-lookup with a k-d tree/spatial hash (or a GPU jump-flood pass), not by dropping it.

Improvements we add over the sketch (his own future-work list):
1. Gaussian smoothing of the flex profile to kill cusp jank.
2. Edge-clamp: first/last slices inherit neighbouring flex to avoid the boundary bend he describes.
3. Even-odd/nonzero-aware sampling to ignore invisible self-intersection tangents (the Playfair W case) — flagged to the glyph-analysis agent as a required test case.
4. Compression handling (stretch < 1): rigid slices must not invert; clamp and renormalize (see `02-lut-remap.mjs`).

---

## 2. Verified performance facts (corrections to the intern RFC)

Primary source: Matt Perry, "The Web Animation Performance Tier List" (motion.dev, Nov 2025) — a current, fact-checked description of the Chromium/WebKit render pipeline. https://motion.dev/magazine/web-animation-performance-tier-list — cross-checked with https://web.dev/articles/animations-overview.

| Claim in RFC | Verdict | Reality |
|---|---|---|
| Variable-font axis mapping is "zero overhead, natively supported by the compositor" | **Wrong** | `font-variation-settings` changes glyph geometry → triggers **layout + paint on the main thread every frame**. Only `transform`, `opacity`, `filter`, `clip-path` composite. It's still the *cheapest* tier for a single headline (browser-native rasterization, no JS math), but it is D-tier work per the pipeline, and it degrades on complex pages. Several blog posts claiming compositor-accelerated font animation are inaccurate; the render-pipeline model and reflow documentation contradict them. |
| SVG `d` mutation is viable for long text | **Partially wrong** | Animating path data triggers **paint every frame** (C-tier) plus per-frame CPU path serialization. Fine for a hero headline (tens of glyphs); wrong tool for dense text or many instances. |
| WebGL is "100% GPU accelerated" | **Nuance** | Shader updates are scheduled by `requestAnimationFrame` on the main thread (A-tier): rendering is massively parallel but frame *timing* can still be blocked by main-thread work. Keep the per-frame JS thin; do all heavy analysis off-thread. |
| Canvas texture capture of DOM text | **Superseded** | Rasterizing stretched text from a canvas texture blurs under magnification. **MSDF** (multi-channel signed distance fields) re-thresholds in the fragment shader so edges stay sharp at any stretch, and preserves sharp corners via 3-channel median. This is the industry-standard solution (msdfgen, troika, three-msdf-text-utils). |
| "Requires a compatible variable font" limits VF tier | **Confirmed** | `wdth` is a registered axis mapped by CSS `font-stretch: <percentage>` (CSS Fonts 4). Only a minority of fonts ship it, and stretch is clamped to the designed axis range — no 4.5× stretch. Correct role: opportunistic cheap tier + highest *typographic* quality when available (widths drawn by the type designer). |

Additional verified facts that shape the architecture:

- **Runtime MSDF/SDF atlas generation from arbitrary fonts is proven.** troika-three-text parses .ttf/.otf/.woff with Typr *at runtime*, generates SDF atlases per glyph on the fly **in a web worker**, GPU-accelerated with a JS fallback, and handles kerning/ligatures/RTL. So the WebGL tier does **not** require pre-baked font assets — "any user font" is satisfiable. (https://github.com/protectwise/troika/blob/main/packages/troika-three-text/README.md)
- **Scroll runs on the compositor thread**; reading `scrollTop` in JS and writing styles is where jank enters. The Lenis + GSAP-ticker pattern (single rAF driver, `lagSmoothing(0)`, all reads/writes batched in one execution block) is the accepted architecture; Motion's `frame.read()/frame.update()` batching is the generalized version. Fontuccine must expose one internal ticker with read/write phases and derive scroll **velocity** internally rather than binding per-element scroll listeners.
- **CSS-variable-driven animation is a trap** (style-recalc "inheritance bomb"); drive per-element uniforms/attributes from JS directly.
- **Layer memory is the hidden cost** of GPU approaches on mobile — one shared WebGL canvas (or few), not one context per element; deactivate offscreen instances via `IntersectionObserver`.

---

## 3. Pipeline benchmark and decision

| | A: WebGL/MSDF | B: SVG path remap | C: Variable font `wdth` |
|---|---|---|---|
| Stroke-true stretch quality | ✔ via flex-LUT in shader; crisp at any ratio (MSDF) | ✔ exact vectors, best possible fidelity | ✔✔ designer-drawn, but only within axis range |
| Any font | ✔ (runtime atlas à la troika) | ✔ (opentype.js outlines) | ✖ needs VF with `wdth` |
| Stretch range | unlimited (e.g. 4.5×) | unlimited | clamped to axis (typ. 50–200%) |
| Per-frame cost | GPU + thin rAF JS (A-tier) | paint + path serialization (C-tier) | main-thread layout+paint (D-tier, element-scoped) |
| Post-fx (grain, displacement, aberration) | ✔ native | ✖ | ✖ |
| Many elements / long text | ✔ | ✖ headlines only | △ few elements |
| Selection/SEO/a11y | needs hidden-DOM overlay | ✔ near-native | ✔ native |
| No-WebGL environments | ✖ | ✔ | ✔ |

**Approved decision (Charbel, 2026-07-11): Hybrid, WebGL-first.** One shared analysis core produces per-glyph flex LUTs; three render tiers consume them:

- **Tier 1 (primary): WebGL2 + runtime MSDF atlas.** Per-glyph quads subdivided into a slice grid; vertex shader remaps positions through the cumulative flex LUT (Nx1 texture per glyph per axis); fragment shader renders MSDF median + fwidth AA, with optional post-fx passes. WebGPU is a later backend behind the same IR, not a launch requirement.
- **Tier 2 (fallback + fidelity mode): SVG path remap.** Same LUT applied to outline points (with bezier subdivision at zone boundaries à la warpjs interpolation / bezier.js `.split(t)`), mutating `d` per frame. Default for no-WebGL, `prefers-reduced-*`, print, and an opt-in "vector fidelity" mode.
- **Tier 0 (opportunistic): `font-stretch`/`wdth` mapping** when the active font is a variable font exposing `wdth` and requested stretch fits the axis range.
- **Accessibility/SEO invariant across tiers:** the original DOM text stays in place (visually hidden, not `display:none`), the render layer is `aria-hidden`; selection targets the real text. Engine honours `prefers-reduced-motion`.

Functional consequences of this choice (vs. committing to a single pipeline): every font works with graceful degradation and post-fx are available — at the cost of three renderers to build/test and a hidden-DOM overlay pattern in Tier 1. Mitigation: tiers are subpath exports (`fontuccine/webgl`, `fontuccine/svg`, `fontuccine/vf`) so bundles only pay for what they import.

### 3.1 Decision note — WebGL Tier 1 is stretch-only (approved 2026-07-12)

Records the approved compression behavior of Tier 1; it realizes, not revises, the §3 decision that "compression is the SVG (vector-fidelity) tier's job."

- **Approved 2026-07-12 (Charbel):** the WebGL tier clamps effective stretch < 1 to identity (natural width). The shader's stretch-independent LUT form (`uOrig + (u_stretch-1)·C(u)`) is exact and monotonic only for stretch ≥ 1; below 1 it folds high-flex glyphs over, and the core's nonlinear water-fill compression guard (`core/lut.ts`) lives on the frozen CPU side and is not reproducible by this linear-in-stretch shader. The fold-over prevention therefore lives at the GPU draw boundary in `src/webgl/renderer.ts` (`stretch = Math.max(1, rawStretch)` in `paint()`), guarded by `test/webgl-stretch-guard.test.ts`. Compression fidelity remains **Tier 2's (SVG)** role.
- **Recorded future enhancement (not implemented):** option B — at the engine/tier-selection layer, when effective stretch < 1, dispatch the run to the SVG tier for true compression instead of clamping to identity. This is held open by the `FUTURE HOOK` comment in `src/webgl/renderer.ts`; the routing belongs at tier selection, not inside the GPU renderer, and is deferred pending a decision.
- **Two known behaviors carried forward (by design):**
  1. The interaction controller may emit a `.value` below `minStretchRatio` on underdamped springs (undershoot below the resting target). This is harmless: the WebGL tier clamps to identity, and the SVG tier's core compression water-fill guard (risk 3, §5) prevents inversion. Left as-is.
  2. `lutResolution` is effectively page-global on the WebGL tier — the shared slice grid is sized to the maximum requested resolution, so a finer per-instance request made after the grid is sized is not honored downward. Phase 5 tidy: add a `console.warn` when a finer instance is requested after the grid is sized.

---

## 4. Ecosystem to build on (no wheel reinventing)

- **Font parsing:** opentype.js (glyph → `M/L/C/Q/Z` commands, kerning; battle-tested) — https://github.com/opentypejs/opentype.js. Alternative used by troika: Typr (smaller, faster parse). Full shaping (Arabic, complex scripts) if ever needed: harfbuzzjs. Start with opentype.js, keep the parser behind an interface.
- **Curve math:** bezier.js by Pomax — `.split(t)` (de Casteljau) for injecting anchor points at protection-zone boundaries; the Bézier Primer as the math reference. https://pomax.github.io/bezierjs/ · https://pomax.github.io/bezierinfo/
- **MSDF:** msdfgen (canonical algorithm, C++) https://github.com/chlumsky/msdfgen; troika's `webgl-sdf-generator` (runtime, worker, GPU-accelerated) as the model for our atlas builder; shader reference collection https://github.com/Blatko1/awesome-msdf; theory https://www.redblobgames.com/articles/sdf-fonts/; survey https://css-tricks.com/techniques-for-rendering-text-with-webgl/.
- **SVG warping precedent:** warpjs (interpolate-then-transform pattern for arbitrary path deformation) https://github.com/benjamminf/warpjs.
- **Interaction plumbing:** Lenis (scroll velocity, single-rAF integration pattern) https://github.com/darkroomengineering/lenis; Motion's batched `frame.read/update` model for thrash-free scheduling.
- **Variable fonts:** MDN Variable Fonts guide https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_fonts/Variable_fonts_guide; Mandy Michael's VF interactivity work https://24ways.org/2019/interactivity-and-animation-with-variable-fonts/.
- **Prior art / inspiration:** Codrops kinetic typography with three.js (render-target text as texture) https://tympanus.net/codrops/2020/06/02/kinetic-typography-with-three-js/; organic text distortion on infinite scroll (velocity→strength mapping) https://tympanus.net/codrops/2024/11/06/how-to-create-an-organic-text-distortion-effect-with-infinite-scrolling/; per-letter shader interaction via raycasting https://tympanus.net/codrops/2025/03/24/animating-letters-with-shaders-interactive-text-effect-with-three-js-glsl/; countertype/three-text (modern troika-class renderer, WebGPU adapters) https://github.com/countertype/three-text.

Full annotated list: `refs/SOURCES.md`.

### 4.1 Tier-2 implementation provenance

These are provenance notes recording *how* the already-approved Tier-2 decision (split-at-boundary → affine-per-slice remap; §3, `refs/examples/05-svg-tier.mjs`) was realized in code. They do not revise the decision. Implementation of record: `src/svg/split.ts`.

- **Boundary-crossing roots are solved closed-form, not via bezier.js.** The zone-boundary crossings that inject anchor points are computed in closed form — quadratic roots / Cardano cubic roots with a Newton polish — operating on the frozen de Casteljau split held by the core geometry. bezier.js was listed here in §4 only as an ecosystem suggestion for `.split(t)`; it is *not* a runtime dependency, and none was added (runtime deps remain just opentype.js; jsdom stays dev-only). The reason for going closed-form is correctness: bezier.js `.intersects` empirically drops near-flat-quadratic boundary crossings (~9.6 unit error reproduced on Georgia 'S'), which would break the exactness invariant. Independent QA verified the closed-form path: worst deviation ~2e-11 font units at stretch up to 4.5×, with zero dropped crossings on the hard cases.
- **One affine per sub-segment, chosen by the on-curve midpoint.** Within each split sub-segment, *all* of its Bézier control points are remapped by a single slice's affine map — the slice selected by the sub-segment's on-curve midpoint — rather than by remapping each control point through the slice it individually falls in. This is a correctness necessity, not a preference: because a curve's convex hull ⊇ the curve, an off-curve control point can lie in a different slice than the curve it shapes, so literal per-control-point remap distorts the outline (~8 units), while the single-affine choice stays exact (~1e-13). This is what makes 05-svg-tier's "exact, no visual approximation" claim hold.

---

## 5. Risks & open questions carried into implementation

1. **Text wrap during interaction.** Stretching changes advance widths. Options: (a) force `white-space: nowrap` on active elements (RFC's suggestion — simplest, recommended default), (b) reserve max-stretch space up front, (c) live reflow (rejected: layout per frame). Default = (a) + optional `reserveSpace: true`.
2. **Self-intersecting outlines** corrupt tangent minima (Playfair W). Required fix: winding-aware filtering of samples; test case in QA suite.
3. **Compression (ratio < 1)** can invert rigid slices; clamp + renormalize (implemented in reference LUT).
4. **GPU memory on mobile:** single shared canvas, atlas LRU eviction, IntersectionObserver deactivation.
5. **WebGL context loss** must restore atlases + buffers (standard `webglcontextlost/restored` handling).
6. **Kerning under stretch:** advances must be remapped with the same LUT sum per glyph, then kerning applied in stretched space — glyph-analysis agent owns correctness here.
7. **npm name** `fontuccine` returned no package from the registry (appears unclaimed as of 2026-07-11; re-verify at publish time).
