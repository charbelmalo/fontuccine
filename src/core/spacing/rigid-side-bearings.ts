/**
 * rigid-side-bearings.ts — RIGID / INK-ONLY side-bearing spacing model.
 *
 * ┌─ STATUS ────────────────────────────────────────────────────────────────┐
 * │ NOT YET IMPLEMENTED. This is a placeholder / extension point only.       │
 * │ There is deliberately no runnable logic here. Do not treat the absence   │
 * │ of code as a bug — the shipped behaviour lives elsewhere (see below).    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ── Background: the SHIPPED default is PROPORTIONAL, not rigid ──────────────
 * The default spacing model is implemented in `src/core/kerning.ts`
 * (`layoutRun`) and is the PROPORTIONAL model. Under a horizontal stretch of
 * ratio r, EVERY glyph advance and EVERY inter-glyph kern scales by exactly r:
 *
 *     stretchedAdvance = advanceWidth · r
 *     stretchedKern    = kernBefore   · r
 *     runWidth         = r · nativeRunWidth
 *
 * i.e. the whole run (ink + side bearings + kerning) grows uniformly by r,
 * and reproduces native metrics EXACTLY at r === 1 (the identity/regression
 * anchor). The user APPROVED keeping the proportional model as the default on
 * 2026-07-12.
 *
 * ── What THIS file will eventually be: the RIGID opt-in alternative ─────────
 * The rigid model is the future, opt-in ALTERNATIVE to proportional. Under it,
 * the empty space stays FIXED (rigid) while only the ink spreads:
 *
 *   • Side bearings (the left/right empty margins of each glyph) do NOT scale.
 *   • Inter-glyph kerning does NOT scale — letter spacing stays constant.
 *   • Only the INK columns of each glyph spread to absorb the stretch.
 *
 * Consequence: a run grows by LESS than r · nativeRunWidth (the fixed spacing
 * is not multiplied), and inter-letter spacing is visually preserved as the
 * text stretches. This is the intended contrast with the proportional default,
 * where spacing grows in lockstep with ink.
 *
 * ── Where the eventual toggle lives ────────────────────────────────────────
 * When implemented, a spacing / side-bearing MODE option would be threaded
 * into `layoutRun()` in `src/core/kerning.ts`: the opt-in would SWAP the
 * proportional advance/kern scaling (advance·r, kern·r) for FIXED spacing,
 * routing the ink-only distribution through this module. It would then be
 * surfaced as a public config field.
 *
 * NOTE (CLAUDE.md rule 9 — user-facing functional decision): adding that
 * config field, and the corresponding config-schema / README changes, is a
 * user-facing decision that REQUIRES user approval via the architect. It is
 * NOT being made now, and this file does not make it. This file only reserves
 * the extension point.
 *
 * TODO(rigid-side-bearings): EXTENSION POINT — implement the rigid / ink-only
 * spacing model here and wire a spacing-mode toggle into `layoutRun()` in
 * `src/core/kerning.ts`. The proportional-vs-rigid decision is already made
 * (proportional is the approved default, 2026-07-12); do NOT re-derive it.
 * The config-schema / README exposure is gated on user approval (CLAUDE.md
 * rule 9) — get that approval before adding the config field.
 */

export {};
