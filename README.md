# Fontuccine

Framework-agnostic, hardware-accelerated font **stretching** that reads like
motion design — not like `scale()`. Interaction-driven (scroll velocity, cursor
proximity, hover, or your own signal), typographically correct on **any**
outline font.

`scale()` distorts everything uniformly — stems fatten, serifs smear, counters
collapse. Fontuccine instead computes a **tangent-aligned flex profile** per
glyph: every slice gets a stretchiness weight from how aligned its outline
tangents are with the stretch direction, so perpendicular strokes, caps, and
serifs stay rigid while aligned runs and empty space absorb the stretch. The
result looks *designed*, at any ratio.

![horizontal stretch demo](demos/demo-horizontal.png)

- **Zero required runtime deps** — `opentype.js` is imported lazily, only when a tier actually parses an outline (never in the base bundle).
- **Three render tiers, auto-dispatched** — WebGL2, SVG, or native variable-font `wdth`, picked from device capability (override with `tier`).
- **Correct by construction** — 147 tests over the math core (17/17 geometric invariants), tier parity, kerning, winding, worker transport, and SSR safety.
- **Any framework, or none** — a vanilla `attach()` core plus a thin React wrapper (`fontuccine/react`). Real DOM text always stays for selection / SEO / a11y.

## Install

```bash
npm install fontuccine
```

## Quickstart

```js
import { Fontuccine } from 'fontuccine';

const stretch = Fontuccine.attach('#headline', {
  fontUrl: '/fonts/RobotoFlex-VF.ttf',
  axis: 'horizontal',
  trigger: 'scroll-velocity',   // or 'mouse-proximity' | 'hover' | 'custom'
  maxStretchRatio: 2.0,
});

// trigger:'custom' — drive it yourself (clamped to [min,max]):
stretch.set(1.6);

await stretch.ready;   // renderer attached
stretch.tier;          // 'webgl' | 'svg' | 'vf' — what actually rendered
stretch.notes;         // tier-selection + fall-through trail
stretch.destroy();     // tear down + restore the DOM (leaks nothing)
```

`attach(target, config)` takes a selector or an `Element` and returns an
`Instance` (`set`, `destroy`, `tier`, `ready`, `notes`). The engine needs the
font outline binary for the SVG/WebGL tiers — pass it via `fontUrl` or
`fontBuffer`.

### React

```jsx
import { Fontuccine, useFontuccine } from 'fontuccine/react';

// component — memoize `config` to avoid re-attaching
<Fontuccine as="h1" config={{ trigger: 'hover', fontUrl: '/fonts/MyFont.ttf' }}>
  Stretchy
</Fontuccine>

// or the hook on your own ref
const ref = useRef(null);
useFontuccine(ref, { trigger: 'mouse-proximity' });
```

`react` / `react-dom` are peer deps; the wrapper is SSR-inert and StrictMode
double-mount safe.

## Render tiers

One flex profile reduces to a **cumulative remap LUT** consumed identically by
three renderers, so the look is stable across the fall-through ladder:

| Tier | Backend | How it stretches |
|---|---|---|
| **1** | WebGL2 + runtime MSDF atlas | GPU slice-grid remap through the LUT texture; crisp at any ratio; supports `effects` (grain, aberration, displacement) |
| **2** | SVG | béziers split at slice boundaries → per-slice affine = mathematically exact; the no-WebGL / fidelity path |
| **0** | Native variable font | drives the font's real `wdth` axis — cheapest, when the font has one |

`tier: 'auto'` (default) probes capability and picks the best available; every
selection and fall-through reason lands on `instance.notes`. Import a tier
directly via `fontuccine/webgl`, `fontuccine/svg`, or `fontuccine/vf`.

> **Compression caveat:** under `tier:'webgl'` the effect is stretch-only — a
> requested compression (effective stretch < 1) clamps to the glyph's natural
> width. Use `tier:'svg'` when you need compression fidelity.

## Key config

| Option | Meaning |
|---|---|
| `axis` | `'horizontal' \| 'vertical' \| 'dual'` |
| `maxStretchRatio` / `minStretchRatio` | stretch bounds |
| `edgeProtection` | Pagurek's *k* — high = hard 9-slice (rigid edges), low = uniform |
| `lutResolution` | slices per axis (analysis resolution) |
| `trigger` | `'scroll-velocity' \| 'mouse-proximity' \| 'hover' \| 'custom'` |
| `physics` / `easingCurve` | spring (`stiffness`/`damping`) or eased motion |
| `effects` | Tier-1 only: `grain`, `aberration`, `displacement` |
| `tier` | force a renderer; omit for auto |
| `wrap` | `'nowrap' \| 'reserve'` — reserve layout so stretching doesn't reflow neighbors |
| `respectReducedMotion` | honor `prefers-reduced-motion` |

## Playground

A Vite app that exercises every tier, effect, and parameter live (and doubles as
the QA visual harness):

```bash
cd playground
npm install
npm run dev     # http://localhost:5173 — hot-reloads the engine source
```

## Develop

```bash
npm install
npm run build      # tsup → dist/ (ESM + .d.ts, per-tier entry points)
npm test           # node --test — 147 tests
npm run typecheck
```

## How it works

`RESEARCH.md` documents the R&D behind the design — the tangent-aligned flex
profile (Pagurek 2025), verified performance facts, the pipeline benchmark, and
the risks. `refs/` holds the annotated sources and standalone reference
implementations (flex profile, LUT remap, MSDF stretch shader).

## License

[MIT](LICENSE) © Charbel Malo
