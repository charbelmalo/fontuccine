/**
 * scripts/size-report.mjs — per-entry gzipped bundle size.
 *
 * Resolves the transitive local-chunk closure of each dist entry (following
 * relative `import ... from './chunk-*.js'`), concatenates them, and gzips —
 * so the number is what a consumer actually ships when importing that subpath.
 * External deps (opentype.js, react) are NOT counted (they resolve from the
 * consumer's node_modules / are peers).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const files = new Set(readdirSync(dist));

function localImports(code) {
  const out = [];
  const re = /(?:import|export)[^'"]*?from\s*['"](\.\/[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code))) out.push(m[1].replace('./', ''));
  // dynamic import()
  const re2 = /import\(\s*['"](\.\/[^'"]+)['"]\s*\)/g;
  while ((m = re2.exec(code))) out.push(m[1].replace('./', ''));
  return out;
}

function closure(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || !files.has(f) || f.endsWith('.map')) continue;
    seen.add(f);
    const code = readFileSync(join(dist, f), 'utf8');
    for (const dep of localImports(code)) if (files.has(dep)) stack.push(dep);
  }
  return [...seen];
}

const entries = {
  'index (engine, all tiers)': 'index.js',
  'svg (Tier 2)': 'svg.js',
  'webgl (Tier 1)': 'webgl.js',
  'vf (Tier 0)': 'vf.js',
  'react (wrapper)': 'react.js',
};

console.log('Fontuccine bundle sizes (ESM, gzipped, excludes external opentype.js/react)\n');
console.log('entry'.padEnd(30), 'files'.padEnd(6), 'raw'.padEnd(10), 'gzip');
console.log('-'.repeat(60));
for (const [label, entry] of Object.entries(entries)) {
  const parts = closure(entry).filter((f) => !f.endsWith('.map'));
  let raw = 0;
  const bufs = [];
  for (const f of parts) {
    const b = readFileSync(join(dist, f));
    raw += b.length;
    bufs.push(b);
  }
  const gz = gzipSync(Buffer.concat(bufs)).length;
  console.log(
    label.padEnd(30),
    String(parts.length).padEnd(6),
    `${(raw / 1024).toFixed(1)}kB`.padEnd(10),
    `${(gz / 1024).toFixed(1)}kB`,
  );
}
