/**
 * worker/spawn-analysis-worker.ts — the ONE place the analysis Worker is spawned.
 *
 * SOURCE form (this file): Vite's first-class worker syntax, so the playground
 * (which aliases `fontuccine` → ../src) and any Vite dev server get a real
 * off-main-thread module worker.
 *
 * DIST form: tsup.config.ts replaces this module at build time (esbuild
 * `onLoad` plugin) with a self-contained version that embeds the pre-bundled
 * worker code as a string and spawns it from a Blob URL. A `.ts` URL can never
 * survive into the published dist — consumers' bundlers could not resolve it
 * (`[vite:worker-import-meta-url] Could not resolve entry module`) and a plain
 * `<script type=module>` would 404 it.
 *
 * Keep the signature in sync with the replacement in tsup.config.ts.
 */
export function spawnAnalysisWorker(): Worker {
  return new Worker(new URL('./analysis-worker.ts', import.meta.url), { type: 'module' });
}
