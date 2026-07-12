# Fontuccine — Annotated Sources

Curated during the R&D phase (2026-07-11). Ordered by how much each source shapes the implementation. Agents: read the ★ sources before writing code in your area.

## Core algorithm

- ★★★ **Tangent-Aligned Text Stretching — Dave Pagurek (2025-09-28)**
  https://www.davepagurek.com/programming/stretch-text/
  The mathematical core Fontuccine adopts. Flex weight per slice `f = min |τ·s|^k` (1 for empty slices); extra space distributed flexbox-style. Read his Background/Results/Future-work sections in full — our roadmap closes his listed gaps (cusp smoothing, edge-slice bend, self-intersection filtering, GPU port).
- ★★★ **Interactive open-source implementation (p5.js)** — fork-friendly reference for sampling density, k values, and expected visual results across Google Fonts: https://openprocessing.org/sketch/2716638
- ★ **9-slice scaling background** (the discrete ancestor of the technique): https://blog.yarsalabs.com/9-slice-scaling-adobe-illustrator/ and https://github.com/catpea/nine-slice

## Rendering-pipeline performance (facts our event architecture is built on)

- ★★★ **The Web Animation Performance Tier List — Matt Perry, motion.dev (2025-11-05)**
  https://motion.dev/magazine/web-animation-performance-tier-list
  Verified model of layout→paint→composite; compositor styles are only `transform/opacity/filter/clip-path`; SVG `d` mutation = paint per frame; shaders are A-tier (rAF-scheduled, GPU-rendered); CSS-variable inheritance bomb; layer-memory warnings; batched read/write (`frame.read/update`) as the thrash-free pattern.
- ★★ **Why are some animations slow? — web.dev**: https://web.dev/articles/animations-overview
- ★ Reflow cost background: https://www.corewebvitals.io/pagespeed/html-reflow-and-core-web-vitals
- **Correction note:** posts claiming `font-variation-settings` animates on the compositor are wrong — it changes glyph geometry, hence layout+paint on the main thread. Treat VF as cheapest-tier-but-not-free. Corroborating discussion of text relayout during VF animation: https://robertcelt95.medium.com/variable-fonts-and-dynamic-typography-the-performance-win-nobodys-talking-about-320f4901d23f (scrutinize its enthusiasm; the relayout caveat is the accurate part).

## Font parsing & curve math

- ★★★ **opentype.js** — glyph outlines as `M/L/C/Q/Z` commands, `Font.getPath`, kerning: https://github.com/opentypejs/opentype.js (README: https://github.com/opentypejs/opentype.js/blob/master/README.md)
- ★★ **bezier.js (Pomax)** — `.split(t)` de Casteljau subdivision for anchor injection at zone boundaries: https://pomax.github.io/bezierjs/
- ★★ **A Primer on Bézier Curves (Pomax)** — the math reference for splitting/derivatives/tangents: https://pomax.github.io/bezierinfo/
- ★ SVG-text-to-path in practice: https://codepen.io/herrstrietzel/pen/GRYxQNd · https://observablehq.com/@tonyhschu/openjs-text-svg-path-extractor
- Alternatives to keep behind the parser interface: **Typr** (what troika uses; faster parse), **harfbuzzjs** (full shaping if complex scripts ever required).

## MSDF / GPU text

- ★★★ **troika-three-text README** — proof that runtime SDF atlas generation from any .ttf/.otf/.woff works in production: parses with Typr, generates atlases on the fly in a **web worker**, GPU-accelerated with JS fallback; kerning/ligatures/RTL handled: https://github.com/protectwise/troika/blob/main/packages/troika-three-text/README.md · docs https://protectwise.github.io/troika/troika-three-text/
- ★★ **msdfgen (Chlumsky)** — canonical MSDF algorithm; corners preserved via multi-channel median: https://github.com/chlumsky/msdfgen
- ★★ **awesome-msdf** — shader recipes (median, fwidth AA, artifacts): https://github.com/Blatko1/awesome-msdf
- ★ **Guide to SDF/MSDF fonts — Red Blob Games**: https://www.redblobgames.com/articles/sdf-fonts/
- ★ **Techniques for rendering text in WebGL — CSS-Tricks**: https://css-tricks.com/techniques-for-rendering-text-with-webgl/
- ★ **countertype/three-text** — modern troika-class renderer with WebGPU adapters (watch for API ideas): https://github.com/countertype/three-text
- Tooling: three-msdf-text-utils https://leochocolat.github.io/three-msdf-text-utils/ · msdf-bmfont-xml for pre-baked atlases (only if we ever ship a "precompiled font" fast path).

## SVG deformation precedent

- ★★ **warpjs** — interpolate-then-transform pattern (inject points until segment length < threshold, then apply arbitrary point transforms). Our SVG tier is this pattern with the flex-LUT as the transform: https://github.com/benjamminf/warpjs

## Interaction / event architecture

- ★★ **Lenis** — scroll velocity exposure, single-rAF integration with GSAP ticker (`lagSmoothing(0)`), scroll-on-compositor caveats: https://github.com/darkroomengineering/lenis
- ★ Building smooth scroll in 2025 (integration walkthrough): https://www.edoardolunardi.dev/blog/building-smooth-scroll-in-2025-with-lenis

## Variable fonts (Tier 0)

- ★★ **MDN Variable Fonts guide** — `wdth` registered axis ↔ `font-stretch: <percentage>` (CSS Fonts 4): https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_fonts/Variable_fonts_guide · descriptor: https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-stretch
- ★ **Mandy Michael — Interactivity and Animation with Variable Fonts** (24 ways, 2019): https://24ways.org/2019/interactivity-and-animation-with-variable-fonts/
- ★ Fit-to-width with wdth axis: https://medium.com/@mandy.michael/resize-text-to-fit-the-parent-with-variable-font-width-axis-16921b6687ae
- Axis browsing for demo fonts: https://v-fonts.com (find `wdth` fonts for the playground).

## Prior art & inspiration (demo page quality bar)

- **Kinetic Typography with Three.js — Codrops (2020)** — render-target text→texture→shader pattern: https://tympanus.net/codrops/2020/06/02/kinetic-typography-with-three-js/
- **Organic Text Distortion with Infinite Scrolling — Codrops (2024)** — scroll-velocity→distortion-strength mapping: https://tympanus.net/codrops/2024/11/06/how-to-create-an-organic-text-distortion-effect-with-infinite-scrolling/
- **Animating Letters with Shaders — Codrops (2025)** — per-letter interaction via raycasting + ShaderMaterial: https://tympanus.net/codrops/2025/03/24/animating-letters-with-shaders-interactive-text-effect-with-three-js-glsl/
- **Bringing Letters to Life: Kinetic SVG Typography — Codrops (2023)**: https://tympanus.net/codrops/2023/01/31/bringing-letters-to-life-coding-a-kinetic-svg-typography-animation/
- Slit-scan typography moodboard: https://www.are.na/lynne-yun/glitch-slit-scan-typography · AE slit-scan tutorial (the "EasyEdit" methodology the RFC references): https://www.youtube.com/watch?v=c13_lUSzX2I
