# Fontuccine playground

A Vite site that exercises every tier, effect, and config parameter live — and
doubles as the QA visual harness surface (see `../harness/`).

```bash
cd playground
npm install
npm run dev        # http://localhost:5173  (hot-reloads the engine SOURCE)
npm run build      # → playground/dist (what the harness serves)
npm run preview    # serve the production build
```

The playground imports the library by its public specifiers (`fontuccine`,
`fontuccine/svg`, …) aliased to `../src` in `vite.config.ts`, so editing the
engine hot-reloads here with **no rebuild step**. Analysis runs in a real module
Worker in the browser (Vite's `new Worker(new URL(...))` path), exactly as
production ships it.

## Views

- **Single** — one target, every README config parameter as a live control
  (axis, trigger, maxStretchRatio, min, edgeProtection *k*, lutResolution, spring
  stiffness/damping, proximityRadius, velocityToStretch, tier override, wrap,
  reserveBasis, reduced-motion, WebGL grain/aberration, and a manual `.set()`
  slider for `trigger:'custom'`). Any change destroys + re-attaches the instance
  (clean-teardown proof) and prints the resolved tier + selection notes.
- **Tier comparison** — the same text/config rendered by all four tiers side by
  side (auto / webgl / svg / vf). One shared manual slider drives them via
  `.set()`. The default `maxStretchRatio` (1.5) fits Roboto Flex's `wdth` axis so
  all four resolve out of the box; push it past **1.51** and watch the VF cell
  honestly fall through to WebGL/SVG (its range exceeds what the designer drew).

## Font

`public/fonts/RobotoFlex-VF.{ttf,woff2}` — Roboto Flex, an OFL-1.1 variable font
with a `wdth` axis (25–151%), from `@fontsource-variable/roboto-flex`. The woff2
backs the CSS `@font-face` the VF (Tier 0) tier stretches natively; the TTF is
fetched by the engine for the SVG/WebGL tiers (opentype.js parses TTF/OTF, not
woff2). Paste any other `.ttf`/`.otf` URL into the "font URL" control for an
arbitrary-font proof.

Not published to npm (the root `package.json` `files` whitelist ships `dist/`
only).
