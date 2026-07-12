# refs/examples — verified reference implementations

| File | What it proves | Status |
|---|---|---|
| `01-flex-profile.mjs` | Tangent-aligned flex analysis (Pagurek) on any outline: interior sampling, even-odd inside test, nearest-boundary tangent field, smoothing | **Tested** |
| `02-lut-remap.mjs` | Flex profile + stretch ratio → monotonic remap, compression guard, normalized GPU LUT | **Tested** |
| `test-invariants.mjs` | 17 invariants: extent, monotonicity, stroke preservation, stretch localization, non-inversion, uniform degradation, LUT safety. `node test-invariants.mjs` | **All pass** |
| `08-real-font-demo.mjs` | End-to-end on DejaVu Serif via opentype.js → `demo-horizontal.png` / `demo-vertical.png` (original vs naive vs tangent-aligned) | **Run — see PNGs** |
| `03/04-msdf-stretch.{vert,frag}.glsl` | Tier-1 shader design: vertex LUT remap + MSDF median/fwidth AA + grain/aberration hooks | Reference (not yet run) |
| `05-svg-tier.mjs` | Tier-2 exactness proof: split béziers at slice boundaries → per-slice affine map of control points is EXACT | Reference (needs bezier-js) |
| `06-interaction-loop.mjs` | Ticker with READ→UPDATE→RENDER phases, scroll velocity + proximity stimuli, springs, reduced-motion | Reference (browser) |
| `07-variable-font-tier.mjs` | Tier-0 `wdth`/`font-stretch` mapping with fvar axis detection | Reference (browser) |

Run the tests / demo:

```bash
npm install            # opentype.js only (for the real-font demo)
node test-invariants.mjs
node 08-real-font-demo.mjs [path/to/font.ttf]
```

Recorded falsification (do not repeat): bucketing boundary samples by axis
coordinate instead of the interior nearest-boundary-tangent field makes solid
stems stretch ~3× (caught by I3). See comments in `01-flex-profile.mjs`.
