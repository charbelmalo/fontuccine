# Fontuccine — working conventions

Read `RESEARCH.md` first in any session; it is the decision record. Public
API contract lives in `README.md`. Multi-module work goes through the
`fontuccine-architect` agent; single-module work goes to the owning agent
(see `.claude/agents/`).

Hard rules distilled from R&D (violations are bugs):

1. Analysis (flex profiles, LUTs) is static per glyph per axis, computed in a
   worker — never per frame, never on the main thread.
2. The interior nearest-boundary-tangent field is required; the
   boundary-bucketing shortcut is falsified (see refs/examples/README.md).
3. All tiers consume the same LUT contract (Float32Array N+1, 0→1, monotonic).
4. One ticker, READ→UPDATE→RENDER phases; no layout reads in event handlers;
   no per-element rAF loops; no CSS-variable-driven animation.
5. `font-variation-settings`/`font-stretch` is main-thread layout+paint —
   Tier 0 is opportunistic, never the headline claim.
6. Real DOM text stays (visually hidden); render layers `aria-hidden`;
   `prefers-reduced-motion` = static in every tier.
7. Per-frame reflow modes are not offered (wrap: nowrap|reserve only).
8. Every landing change passes `refs/examples/test-invariants.mjs` (or its
   package-test port) plus the qa-perf-auditor gate.
9. User-facing functional decisions: state the difference, get approval
   (user preference — see architect agent).
