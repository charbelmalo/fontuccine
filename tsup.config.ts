import { defineConfig } from 'tsup';

/**
 * Per-subpath entry points so a bundle pays only for the tier it imports
 * (RESEARCH §3). `index` is the auto engine (statically imports all tiers);
 * `svg`/`webgl`/`vf` are renderer-only; `react` is the thin wrapper.
 *
 * `opentype.js` stays EXTERNAL (a runtime dependency, dynamically imported by
 * engine/font-load) so it never lands in the base bundle — it resolves from the
 * consumer's node_modules on demand. `react`/`react-dom` are external peers.
 *
 * ESM-only, tree-shaken, `.d.ts` emitted per entry. `splitting` shares common
 * chunks (core/interaction) across the tier bundles and isolates the lazy
 * font-parse chunk.
 *
 * `sourcemap` is OFF: `.map` files are intentionally excluded from the
 * published tarball (they embed full `sourcesContent` — source-leak
 * avoidance). Generating maps would leave a dangling `//# sourceMappingURL=`
 * comment in the shipped entry `.js`, so we don't emit them at all. No tooling
 * depends on them (size-report filters `.map`; harness serves them only if
 * present).
 */
export default defineConfig({
  entry: {
    index: 'src/engine/index.ts',
    svg: 'src/entries/svg.ts',
    webgl: 'src/entries/webgl.ts',
    vf: 'src/entries/vf.ts',
    react: 'src/react/index.ts',
  },
  format: ['esm'],
  target: 'es2022',
  platform: 'browser',
  dts: true,
  splitting: true,
  treeshake: true,
  sourcemap: false,
  clean: true,
  minify: false,
  external: ['opentype.js', 'react', 'react-dom'],
});
