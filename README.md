# Fontuccine

Framework-agnostic, hardware-accelerated font stretching that looks like
motion design, not like `scale()`. Interaction-driven (scroll velocity,
cursor proximity, hover), typographically correct on **any** outline font.

**Status:** R&D complete, architecture approved, math core verified. Ready for implementation.

## What's in this repo

| Path | Contents |
|---|---|
| `RESEARCH.md` | R&D findings, verified perf facts (with corrections to the original RFC), pipeline benchmark, the approved decision, risks |
| `refs/SOURCES.md` | Annotated source list (★-rated per implementation area) |
| `refs/examples/` | **Verified** reference implementations: analysis core + remap LUT (17/17 invariants passing), real-font demo renders (DejaVu Serif, see `demo-*.png`), Tier-1 GLSL pair, Tier-2 exact-affine SVG algorithm, ticker/stimuli architecture, Tier-0 VF mapping |
| `.claude/agents/` | The implementation team: architect (orchestrator), glyph-analysis, gpu-render, dom-render, interaction, packaging, qa-perf-auditor |

## The approved architecture (one paragraph)

A worker computes, once per glyph per axis, a **tangent-aligned flex profile**
(Pagurek 2025): every slice of the glyph gets a stretchiness weight from how
aligned its nearest outline tangents are with the stretch direction — so
perpendicular strokes, caps and serifs stay rigid while aligned/empty zones
absorb the stretch. The profile reduces to a **cumulative remap LUT** consumed
identically by three renderers: **Tier 1 WebGL2 + runtime MSDF atlas**
(primary: vertex-remap through the LUT texture, crisp at any ratio, post-fx
capable), **Tier 2 SVG** (split béziers at slice boundaries → per-slice affine
control-point remap = mathematically exact; no-WebGL fallback), **Tier 0
variable-font `wdth`** (opportunistic, clamped to the axis range). One ticker
(READ→UPDATE→RENDER) drives springs from scroll-velocity/proximity/hover
stimuli. Real DOM text always remains for selection/SEO/a11y.

**Tier behavior note:** under `tier: 'webgl'` (Tier 1) the effect is
stretch-only — a requested compression (effective stretch < 1) clamps to the
glyph's natural width. Use `tier: 'svg'` (Tier 2) when you need compression
fidelity.

## Public API sketch (the contract the agents build to)

```ts
import { Fontuccine } from 'fontuccine';

const instance = Fontuccine.attach('#hero', {
  axis: 'horizontal' | 'vertical' | 'dual',
  trigger: 'scroll-velocity' | 'mouse-proximity' | 'hover' | 'custom',

  maxStretchRatio: 4.5,
  minStretchRatio: 1,
  edgeProtection: 8,          // Pagurek's k: high = hard 9-slice, low = uniform
  lutResolution: 96,          // slices per axis

  physics: { stiffness: 140, damping: 22 },   // or easingCurve: 'cubic-bezier(…)'
  easingDuration: 0.3,        // tween length (s) for the easingCurve alternative; default 0.3
  proximityRadius: 240,
  velocityToStretch: 0.002,

  tier: 'auto' | 'webgl' | 'svg' | 'vf',
  effects: {                   // Tier-1 only; ignored elsewhere
    grain: 0.15,
    aberration: { max: 2.5, fromVelocity: true },
    displacement: { texture: '/textures/tv-noise.png', intensity: 1.5 },
  },

  wrap: 'nowrap' | 'reserve', // reflow-per-frame is not offered (by design)
  reserveBasis: 'tier-capability' | 'uniform', // (default 'tier-capability') how wrap:'reserve' sizes the box: 'tier-capability' = each tier reserves what it can actually paint (Tiers 1/2 × maxStretchRatio, VF × axis-max); 'uniform' = every tier reserves × maxStretchRatio for cross-tier consistency (VF leaves a permanent gap)
  respectReducedMotion: true,
});

instance.set(1.8);            // manual drive (trigger: 'custom')
instance.destroy();
```

## Install & usage

```bash
npm install fontuccine
```

ESM-only, framework-agnostic. Subpath exports so a bundle pays only for the tier
it imports:

| Import | What you get |
|---|---|
| `fontuccine` | The engine: `Fontuccine.attach(target, config)` with `tier:'auto'` dispatch (WebGL primary → VF opportunistic → SVG fallback). |
| `fontuccine/svg` | Tier 2 renderer only (`createSvgRenderer`) — exact vectors, no-WebGL/fidelity path. |
| `fontuccine/webgl` | Tier 1 renderer only (`createWebglRenderer`) — WebGL2 + runtime MSDF, post-fx. |
| `fontuccine/vf` | Tier 0 only (`createVfRenderer`, `probeTier0`) — opportunistic variable-font `wdth`. |
| `fontuccine/react` | The React wrapper (`<Fontuccine>`, `useFontuccine`). |

The auto engine needs the font outline binary for the SVG/WebGL tiers; pass it
via `fontUrl` / `fontBuffer` (opentype.js is loaded lazily, only when a binary is
actually parsed — never in the base bundle). The VF tier needs no binary beyond
`wdth`-axis detection.

```ts
import { Fontuccine } from 'fontuccine';

const instance = Fontuccine.attach('#hero', {
  trigger: 'scroll-velocity',
  maxStretchRatio: 3,
  fontUrl: '/fonts/MyFont.ttf',
});
// instance.tier → 'webgl' | 'svg' | 'vf' ; instance.notes → why
```

### React

`react` / `react-dom` are peerDependencies. The wrapper is thin (props → config;
no framework-specific animation logic), SSR-inert (attach runs in an effect), and
React 18/19 StrictMode double-mount safe.

```tsx
import { Fontuccine, useFontuccine } from 'fontuccine/react';

// component — the real text stays in the DOM for a11y/SEO
<Fontuccine as="h1" config={{ trigger: 'hover', fontUrl: '/fonts/MyFont.ttf' }}>
  Stretch me
</Fontuccine>

// or the hook on your own ref (memoize `config` to avoid re-attaching)
const ref = useRef<HTMLHeadingElement>(null);
useFontuccine(ref, { trigger: 'mouse-proximity' });
```

**Vue and Svelte wrappers are deferred (FUTURE).** They will be equally thin
adapters over the same `attach`/`destroy` interface — the engine already carries
all animation logic, so a wrapper adds none. They are intentionally not built in
this phase.

## Verify the math core right now

```bash
cd refs/examples
npm install
node test-invariants.mjs      # 17 invariants — all pass
node 08-real-font-demo.mjs    # regenerates demo-horizontal.png / demo-vertical.png
```

`demo-horizontal.png`: DejaVu Serif R/B/H at 2.5× — naive scaling fattens
stems 2.5×; Fontuccine keeps stroke weight and serifs, stretching only
aligned zones. `demo-vertical.png`: S/E at 2× vertical.

## Roadmap (agents, in order)

1. **glyph-analysis-engineer** — productionize core: k-d tree, worker
   protocol, self-intersection filtering, kerning in stretched space.
2. **interaction-engineer** — ticker + stimuli + springs (unblocks demos).
3. **dom-render-engineer** — SVG tier first (visible results, QA baseline),
   then VF tier + a11y overlay.
4. **gpu-render-engineer** — MSDF atlas + instanced renderer + post-fx.
5. **packaging-engineer** — exports, wrappers, playground.
6. **qa-perf-auditor** — gates every step (suite seeded by
   `test-invariants.mjs`; it already caught one falsified optimization in R&D).
