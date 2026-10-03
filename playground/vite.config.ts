import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * The playground imports the library by its public specifiers (`fontuccine`,
 * `fontuccine/svg`, …) but resolves them to the TypeScript SOURCE, not the built
 * dist — so editing the engine hot-reloads here with no rebuild step. Vite's
 * esbuild handles the explicit `.ts` import extensions the source uses, and the
 * `new Worker(new URL('./analysis-worker.ts', import.meta.url), {type:'module'})`
 * pattern in worker/spawn-analysis-worker.ts (and webgl/msdf/spawn-msdf-worker.ts) is Vite's first-class worker syntax (real off-main
 * -thread analysis in the browser, exactly as production ships it).
 */
const src = (p: string) => fileURLToPath(new URL(`../src/${p}`, import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  resolve: {
    alias: {
      'fontuccine/svg': src('entries/svg.ts'),
      'fontuccine/webgl': src('entries/webgl.ts'),
      'fontuccine/vf': src('entries/vf.ts'),
      'fontuccine/react': src('react/index.ts'),
      fontuccine: src('engine/index.ts'),
    },
  },
  server: {
    fs: {
      // The source package lives outside the playground root, and the
      // analysis worker is loaded as a module worker from src/worker/.
      allow: [fileURLToPath(new URL('.', import.meta.url)), fileURLToPath(new URL('..', import.meta.url))],
    },
  },
  worker: { format: 'es' },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
});
