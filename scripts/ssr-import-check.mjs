globalThis.window = undefined;
globalThis.document = undefined;
const base = new URL('../dist/', import.meta.url);
const entries = ['index.js','svg.js','webgl.js','vf.js','react.js'];
let ok = true;
for (const e of entries) {
  try {
    const m = await import(new URL(e, base).href);
    console.log(`OK   ${e}  exports: ${Object.keys(m).join(', ') || '(default only)'}`);
  } catch (err) { ok = false; console.log(`FAIL ${e}  ${err.message}`); }
}
const { attach } = await import(new URL('index.js', base).href);
const inst = attach('#nope', {});
console.log('SSR attach() no-op → tier:', inst.tier, '| note:', inst.notes[0]);
inst.set(2); inst.destroy();
console.log(ok ? '\nALL SUBPATHS SSR-SAFE' : '\nSSR FAILURES'); process.exit(ok?0:1);
