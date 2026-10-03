import { defineConfig } from 'tsup';
import type { Plugin } from 'esbuild';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

/**
 * Inline Web Workers into the dist.
 *
 * Source spawns workers with Vite's `new Worker(new URL('./x.ts',
 * import.meta.url), { type: 'module' })` (see src/worker/spawn-analysis-worker.ts
 * and src/webgl/msdf/spawn-msdf-worker.ts). tsup/esbuild does not emit that
 * worker entry, so the `.ts` URL would ship verbatim and break every consumer
 * (Vite: "Could not resolve entry module …/dist/analysis-worker.ts"; plain
 * `<script type=module>`: 404). This plugin replaces ONLY those two spawn
 * modules at build time: the worker entry is bundled with esbuild into one
 * self-contained ESM string, embedded as a JSON literal, and spawned from a
 * Blob URL — no extra files, no bundler cooperation needed on the consumer side.
 */
const WORKER_SPAWNERS: Record<string, { entry: string; fn: string }> = {
  [fileURLToPath(new URL('./src/worker/spawn-analysis-worker.ts', import.meta.url))]: {
    entry: fileURLToPath(new URL('./src/worker/analysis-worker.ts', import.meta.url)),
    fn: 'spawnAnalysisWorker',
  },
  [fileURLToPath(new URL('./src/webgl/msdf/spawn-msdf-worker.ts', import.meta.url))]: {
    entry: fileURLToPath(new URL('./src/webgl/msdf/worker.ts', import.meta.url)),
    fn: 'spawnMsdfWorker',
  },
};

/** Paths actually replaced during this build (checked in onEnd). */
const inlinedSpawners = new Set<string>();

const inlineWorkerPlugin: Plugin = {
  name: 'fontuccine-inline-worker',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /spawn-(analysis|msdf)-worker\.ts$/ }, async (args) => {
      const spec = WORKER_SPAWNERS[args.path];
      if (!spec) return undefined;
      const out = await build({
        entryPoints: [spec.entry],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        write: false,
        minify: true,
        legalComments: 'none',
        logLevel: 'silent',
      });
      const code = out.outputFiles[0]!.text;
      if (/import\.meta\.url|new URL\(/.test(code)) {
        throw new Error(`inline worker ${spec.entry} still references import.meta.url / new URL()`);
      }
      inlinedSpawners.add(args.path);
      const contents = `
const WORKER_CODE = ${JSON.stringify(code)};
export function ${spec.fn}() {
  const url = URL.createObjectURL(new Blob([WORKER_CODE], { type: 'text/javascript' }));
  let revoked = false;
  const revoke = () => {
    if (revoked) return;
    revoked = true;
    URL.revokeObjectURL(url);
  };
  let worker;
  try {
    worker = new Worker(url, { type: 'module' });
  } catch (err) {
    revoke();
    throw err;
  }
  // Revoke once the worker has provably loaded (first message) or failed;
  // a timer backstop keeps an idle worker from pinning the Blob forever.
  worker.addEventListener('message', revoke, { once: true });
  worker.addEventListener('error', revoke, { once: true });
  setTimeout(revoke, 30000);
  return worker;
}
`;
      return { contents, loader: 'js', resolveDir: args.path.replace(/\/[^/]*$/, '') };
    });
    pluginBuild.onEnd((result) => {
      if (result.errors.length) return;
      // Every spawner reachable from this build must have been replaced.
      const missing = Object.keys(WORKER_SPAWNERS).filter(
        (p) => result.metafile?.inputs && Object.keys(result.metafile.inputs).some((i) => p.endsWith(i)) && !inlinedSpawners.has(p),
      );
      if (missing.length) throw new Error(`inline-worker plugin did not replace: ${missing.join(', ')}`);
    });
  },
};

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
  esbuildPlugins: [inlineWorkerPlugin],
});
