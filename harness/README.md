# Fontuccine real-browser harness

A visual-regression + geometry matrix that drives the built playground in real
headless Chrome (puppeteer-core against the system Chrome, WebGL2 via ANGLE
SwiftShader).

```bash
npm run harness        # from the repo root
# or: node harness/run.mjs
```

It auto-builds `playground/dist` if missing, serves it on `:4318`, and runs the
matrix. Set `CHROME_PATH` to override Chrome detection.

## Two classes of check (reported separately)

**IN-RUNTIME** — assertions that actually executed in the browser this run
(exit code is non-zero if any fail — CI gate):

| # | Scenario | Asserts |
|---|---|---|
| 1 | `auto` | auto selects **WebGL** when WebGL2 is present; the single shared GL canvas is mounted and viewport-sized (scissor target). |
| 2 | `webgl` forced | resolves to WebGL. |
| 3 | `svg` | draws exactly one `<path>` per glyph (per-glyph bézier split); ink width grows **monotonically** with stretch ratio (1 < 2 < 3). |
| 4 | reduced-motion | `auto` under reduced motion resolves to **SVG**, and the selection note records the reason. |
| 5 | `vf` (in-range) | resolves to VF; `font-stretch` is a real percentage **inside the designed `wdth` axis** (ratio 1.4 → ~140%, clamped ≤151%). |
| 6 | parity | VF vs SVG **ink-width delta** at a matched ratio is measured and bounded (they use different techniques — designed masters vs tangent remap — so the delta is reported, ~5%, not asserted identical). |

**BY-INSPECTION** — full-page screenshots saved to `harness/screenshots/` for a
human or an image-diff CI step to judge WebGL **scissor↔proxy pixel alignment**
and **MSDF edge sharpness under stretch**. These are *not* pixel-read in-page:
the shared GL context ships without `preserveDrawingBuffer`, so an in-page
readback is unreliable. The full-viewport shared canvas overlays the host 1:1, so
each screenshot is a faithful capture of exactly what shipped.

## Why the split

The VF range-fit and forced-tier fall-through logic is *also* covered by the pure
Node unit tests (`test/engine-tier-select.test.ts`) — the harness confirms the
same decisions hold in a real engine + real Chrome, on real font binaries, with
real geometry measured off the live DOM/SVG.

The scenarios are query-driven pages in the playground (`?harness=1&tier=…&
ratio=…&maxr=…&text=…`) — see `playground/src/harness.ts`.
