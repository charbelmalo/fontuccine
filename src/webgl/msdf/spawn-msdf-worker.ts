/**
 * webgl/msdf/spawn-msdf-worker.ts — the ONE place the MSDF Worker is spawned.
 *
 * SOURCE form (this file): Vite's first-class worker syntax (playground / Vite
 * dev). DIST form: tsup.config.ts swaps this module at build time for a version
 * that embeds the pre-bundled worker code and spawns it from a Blob URL, so no
 * unresolvable `.ts` URL ever ships. See src/worker/spawn-analysis-worker.ts.
 *
 * Keep the signature in sync with the replacement in tsup.config.ts.
 */
export function spawnMsdfWorker(): Worker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
}
