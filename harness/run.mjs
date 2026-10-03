/**
 * harness/run.mjs — real-browser visual-regression + geometry matrix.
 *
 * Builds the playground (Vite → static), serves it, drives headless Chrome via
 * puppeteer-core against the system Chrome install, and runs the QA matrix over
 * every tier. Two classes of check, reported separately (per the Phase-5 brief):
 *
 *   IN-RUNTIME  — assertions that actually executed in the browser this run:
 *     tier selection (auto→WebGL, forced svg/vf, reduced-motion→svg), SVG exact
 *     per-glyph vector geometry + monotonic growth, VF percentage semantics
 *     (font-stretch within the designed axis), VF↔SVG ink-width parity delta,
 *     single-shared-WebGL-context plumbing (canvas present + viewport-sized).
 *
 *   PIXEL — WebGL vs SVG ink parity, measured from screenshots: the host box is
 *     cropped from a WebGL run and from the matching SVG run (same text, ratio,
 *     font size), both are thresholded to ink masks and compared (intersection
 *     over union + the number of large "xor" islands, which is what torn MSDF
 *     junctions and missing strokes produce). Gate: IoU >= PIXEL_MIN_IOU and
 *     large islands <= PIXEL_MAX_BIG. The broken 0.1.0 generator scored IoU
 *     0.79 with 24 large islands on the reference phrase; the fixed one 0.96 / 0.
 *
 *   BY-INSPECTION — full-page screenshots saved to harness/screenshots/ for a
 *     human to eyeball at 1:1 (they are the same captures the PIXEL gate reads).
 *
 * Exit code is non-zero if any IN-RUNTIME or PIXEL assertion fails (CI gate).
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLAY_DIST = join(ROOT, 'playground', 'dist');
const SHOTS = join(ROOT, 'harness', 'screenshots');
const PORT = 4318;
const PIXEL_MIN_IOU = 0.93;
const PIXEL_MAX_BIG = 8; // xor islands larger than PIXEL_BIG_PX pixels
const PIXEL_BIG_PX = 40;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

// Always rebuild: a stale playground/dist silently tests yesterday's source.
// Set FONTUCCINE_HARNESS_SKIP_BUILD=1 to reuse an existing dist deliberately.
async function ensurePlaygroundBuilt() {
  if (process.env.FONTUCCINE_HARNESS_SKIP_BUILD === '1') {
    if (!existsSync(join(PLAY_DIST, 'index.html'))) {
      throw new Error('FONTUCCINE_HARNESS_SKIP_BUILD=1 but playground/dist/index.html does not exist');
    }
    console.log('· FONTUCCINE_HARNESS_SKIP_BUILD=1 → reusing existing playground/dist');
    return;
  }
  console.log('· building playground (vite build) …');
  const vite = join(ROOT, 'playground', 'node_modules', '.bin', 'vite');
  if (!existsSync(vite)) {
    throw new Error('playground/node_modules/.bin/vite missing — run `npm --prefix playground install`');
  }
  const r = spawnSync(vite, ['build'], { cwd: join(ROOT, 'playground'), stdio: 'inherit' });
  if (r.status !== 0) throw new Error('playground build failed');
}

function serve(distDir) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      let p = normalize(decodeURIComponent(url.pathname));
      if (p === '/' || p.endsWith('/')) p += 'index.html';
      const file = join(distDir, p);
      if (!file.startsWith(distDir)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

// ── assertion helpers ────────────────────────────────────────────────────────
const results = [];
function record(scenario, kind, name, ok, detail) {
  results.push({ scenario, kind, name, ok, detail });
  const tag = ok ? '  ✓' : '  ✗';
  console.log(`${tag} [${kind}] ${scenario} · ${name}${detail ? ` — ${detail}` : ''}`);
}

async function openScenario(browser, query, viewport = { width: 1100, height: 600 }) {
  const page = await browser.newPage();
  await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
  await page.goto(`http://localhost:${PORT}/index.html?${query}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__H && window.__H.ready === true', { timeout: 8000 });
  return page;
}
async function H(page) { return page.evaluate(() => {
  const h = window.__H;
  return { resolvedTier: h.resolvedTier, requestedTier: h.requestedTier, notes: h.notes,
    ink: h.ink(), host: h.host(), vf: h.vf(), glyphPaths: h.glyphPaths(), webgl: h.webglCanvas(),
    hostRect: h.hostRect ? h.hostRect() : null };
}); }

// ── PIXEL gate helpers ───────────────────────────────────────────────────────
// Screenshot the host box (plus a margin for the stretched run, which may extend
// past the host's own box) as a base64 PNG. The pixel scenarios open a viewport
// wide enough for the whole run, and `captureBeyondViewport` is forced OFF:
// puppeteer defaults it to true whenever a `clip` is given, and in that mode the
// headless shell composites neither canvases nor off-viewport content (the
// WebGL surface came back blank, the off-viewport area black, for both tiers).
const PIXEL_VIEWPORT = { width: 2400, height: 400 };
async function hostClipPng(page, h, pad = 8) {
  const r = h.hostRect;
  const x = Math.max(0, r.x - pad), y = Math.max(0, r.y - pad);
  const clip = { x, y, width: Math.min(PIXEL_VIEWPORT.width - x, PIXEL_VIEWPORT.width), height: Math.min(r.h + pad * 2, PIXEL_VIEWPORT.height - y) };
  return page.screenshot({ clip, encoding: 'base64', captureBeyondViewport: false });
}

// Decode two PNG clips in a scratch page and compare their ink masks.
async function compareInk(browser, pngA, pngB) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ([a, b]) => {
      const load = (b64) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = 'data:image/png;base64,' + b64; });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const w = Math.min(ia.width, ib.width), hgt = Math.min(ia.height, ib.height);
      const mask = (im) => {
        const c = document.createElement('canvas'); c.width = w; c.height = hgt;
        const g = c.getContext('2d'); g.drawImage(im, 0, 0);
        const d = g.getImageData(0, 0, w, hgt).data;
        const m = new Uint8Array(w * hgt);
        // ink = far from the page background (the harness page is white / black ink)
        for (let i = 0; i < w * hgt; i++) { const o = i * 4; const dist = Math.abs(255 - d[o]) + Math.abs(255 - d[o + 1]) + Math.abs(255 - d[o + 2]); m[i] = dist > 120 ? 1 : 0; }
        return m;
      };
      const ma = mask(ia), mb = mask(ib);
      let inter = 0, union = 0, inkA = 0, inkB = 0;
      const xor = new Uint8Array(w * hgt);
      for (let i = 0; i < w * hgt; i++) { inkA += ma[i]; inkB += mb[i]; if (ma[i] && mb[i]) inter++; if (ma[i] || mb[i]) union++; xor[i] = ma[i] !== mb[i] ? 1 : 0; }
      // Islands: 4-connected components of the xor mask AFTER a 1-px erosion.
      // A 1–2 px ribbon along a long stroke edge is an anti-aliasing threshold
      // difference (both tiers draw the same outline, one lands half a pixel
      // fatter); it vanishes under erosion. A torn junction, a missing stroke
      // or a collapsed diagonal is ≥ 3 px thick and survives.
      const er = new Uint8Array(w * hgt);
      for (let y = 1; y < hgt - 1; y++) for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        er[p] = xor[p] && xor[p - 1] && xor[p + 1] && xor[p - w] && xor[p + w] ? 1 : 0;
      }
      const seen = new Uint8Array(w * hgt); const sizes = []; const stack = [];
      for (let s = 0; s < w * hgt; s++) {
        if (!er[s] || seen[s]) continue;
        let n = 0; stack.push(s); seen[s] = 1;
        while (stack.length) { const p = stack.pop(); n++; const x = p % w, y = (p - x) / w;
          const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < hgt - 1 ? p + w : -1];
          for (const q of nb) if (q >= 0 && er[q] && !seen[q]) { seen[q] = 1; stack.push(q); } }
        sizes.push(n);
      }
      let xorPx = 0; for (let i = 0; i < w * hgt; i++) xorPx += xor[i];
      return { w, h: hgt, inkA, inkB, iou: union ? inter / union : 1, xor: xorPx, comps: sizes.length, maxComp: sizes.length ? Math.max(...sizes) : 0, sizes };
    }, [pngA, pngB]);
  } finally { await page.close(); }
}

async function pixelGate(browser, scenario, query) {
  const shots = {};
  const meta = {};
  for (const tier of ['webgl', 'svg']) {
    const page = await openScenario(browser, `harness=1&tier=${tier}&${query}`, PIXEL_VIEWPORT);
    const h = await H(page);
    meta[tier] = h;
    shots[tier] = await hostClipPng(page, h);
    await mkdir(SHOTS, { recursive: true });
    await writeFile(join(SHOTS, `${scenario}-${tier}.clip.png`), Buffer.from(shots[tier], 'base64'));
    await shot(page, `${scenario}-${tier}`);
    await page.close();
  }
  if (meta.webgl.resolvedTier !== 'webgl' || meta.svg.resolvedTier !== 'svg') {
    record(scenario, 'PIXEL', 'both tiers resolved for the parity check', false, `webgl→${meta.webgl.resolvedTier} svg→${meta.svg.resolvedTier}`);
    return;
  }
  const m = await compareInk(browser, shots.webgl, shots.svg);
  const big = m.sizes.filter((s) => s > PIXEL_BIG_PX).length;
  const inkRatio = m.inkB ? m.inkA / m.inkB : 0;
  record(scenario, 'PIXEL', `WebGL↔SVG ink IoU ≥ ${PIXEL_MIN_IOU}`, m.iou >= PIXEL_MIN_IOU, `IoU=${m.iou.toFixed(4)} ink webgl/svg=${inkRatio.toFixed(3)} (${m.w}×${m.h}px)`);
  record(scenario, 'PIXEL', `≤ ${PIXEL_MAX_BIG} torn/missing islands (> ${PIXEL_BIG_PX}px after 1px erosion)`, big <= PIXEL_MAX_BIG, `big=${big} islands=${m.comps} maxIsland=${m.maxComp}px xor=${m.xor}px (clips: harness/screenshots/${scenario}-{webgl,svg}.clip.png)`);
}

async function shot(page, name) {
  await mkdir(SHOTS, { recursive: true });
  const file = join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  record(name, 'BY-INSPECTION', 'screenshot saved', true, `harness/screenshots/${name}.png`);
}

async function run() {
  await ensurePlaygroundBuilt();
  const exe = findChrome();
  if (!exe) throw new Error('no Chrome/Chromium found (set CHROME_PATH)');
  console.log(`· chrome: ${exe}`);
  const server = await serve(PLAY_DIST);
  console.log(`· serving ${PLAY_DIST} on :${PORT}`);

  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: 'shell',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--enable-webgl', '--disable-dev-shm-usage',
    ],
  });

  try {
    // 1 · auto → WebGL when WebGL2 present (swiftshader) --------------------------
    {
      const page = await openScenario(browser, 'harness=1&tier=auto&ratio=2.5&text=Ho');
      const h = await H(page);
      const gpu = h.resolvedTier === 'webgl';
      record('auto', 'IN-RUNTIME', 'auto selects WebGL when WebGL2 present', gpu, `resolved=${h.resolvedTier}`);
      record('auto', 'IN-RUNTIME', 'per-host WebGL surface mounted INSIDE the host + sized to the run',
        !!h.webgl?.present && h.webgl.inHost && h.webgl.w > 0 && h.webgl.h > 0, `${h.webgl?.w}×${h.webgl?.h} inHost=${h.webgl?.inHost}`);
      await shot(page, 'auto-webgl-ratio2.5');
      await page.close();
    }

    // 2 · forced WebGL + MSDF sharpness screenshot -------------------------------
    {
      const page = await openScenario(browser, 'harness=1&tier=webgl&ratio=3&text=Ro');
      const h = await H(page);
      record('webgl', 'IN-RUNTIME', 'forced webgl resolves to webgl', h.resolvedTier === 'webgl', `resolved=${h.resolvedTier}`);
      await shot(page, 'webgl-msdf-ratio3');
      await page.close();
    }

    // 2b · PIXEL gate: WebGL ink must match the exact SVG ink ---------------------
    await pixelGate(browser, 'pixel-phrase-2.5', 'ratio=2.5&text=Stretch+with+intention');
    await pixelGate(browser, 'pixel-caps-2.5', 'ratio=2.5&text=RBH');
    await pixelGate(browser, 'pixel-wy-2.0', 'ratio=2&text=wavy');

    // 3 · SVG exact per-glyph vectors + monotonic growth -------------------------
    {
      const widths = [];
      for (const r of [1, 2, 3]) {
        const page = await openScenario(browser, `harness=1&tier=svg&ratio=${r}&text=Ho`);
        const h = await H(page);
        if (r === 2) {
          record('svg', 'IN-RUNTIME', 'SVG draws one <path> per glyph', h.glyphPaths === 2, `paths=${h.glyphPaths}`);
          await shot(page, 'svg-ratio2');
        }
        widths.push(h.ink?.w ?? 0);
        await page.close();
      }
      const mono = widths[0] < widths[1] && widths[1] < widths[2];
      record('svg', 'IN-RUNTIME', 'ink width grows monotonically with stretch ratio', mono,
        widths.map((w) => w.toFixed(1)).join(' < '));
    }

    // 4 · reduced motion forces SVG (auto) + static ------------------------------
    {
      const page = await openScenario(browser, 'harness=1&tier=auto&ratio=2.5&rm=1&text=Ho');
      const h = await H(page);
      record('reduced-motion', 'IN-RUNTIME', 'auto under reduced-motion resolves to SVG', h.resolvedTier === 'svg', `resolved=${h.resolvedTier}`);
      record('reduced-motion', 'IN-RUNTIME', 'note records the reduced-motion reason',
        h.notes.join(' ').includes('reduced-motion'), h.notes.join(' | '));
      await page.close();
    }

    // 5 · VF percentage semantics (font-stretch within designed axis) ------------
    // Roboto Flex wdth axis is 25–151%; keep the requested range inside it (maxr)
    // so the opportunistic VF tier is actually taken (it declines ranges it can't
    // honor — that decline path is covered by the pure tier-select unit tests).
    let vfWidth = null;
    {
      const page = await openScenario(browser, 'harness=1&tier=vf&ratio=1.4&maxr=1.5&text=Ho');
      const h = await H(page);
      record('vf', 'IN-RUNTIME', 'forced vf resolves to vf (wdth font, in-range)', h.resolvedTier === 'vf', `resolved=${h.resolvedTier} notes=${h.notes.join('|')}`);
      const pct = parseFloat(String(h.vf?.fontStretch ?? '').replace('%', ''));
      const within = Number.isFinite(pct) && pct > 100 && pct <= 151;
      record('vf', 'IN-RUNTIME', 'font-stretch is a real percentage inside the designed wdth axis', within, `font-stretch=${h.vf?.fontStretch} (ratio 1.4 → ~140%)`);
      vfWidth = h.ink?.w ?? null;
      await shot(page, 'vf-ratio1.4');
      await page.close();
    }

    // 6 · VF ↔ SVG geometry parity at a matched ratio (delta, reported) ----------
    {
      const page = await openScenario(browser, 'harness=1&tier=svg&ratio=1.4&maxr=1.5&text=Ho');
      const h = await H(page);
      const svgW = h.ink?.w ?? null;
      await page.close();
      if (vfWidth && svgW) {
        const delta = Math.abs(vfWidth - svgW) / svgW;
        // Different techniques (designed masters vs tangent remap) → not identical.
        // We assert both live in the same order of magnitude, and REPORT the delta.
        record('parity', 'IN-RUNTIME', 'VF↔SVG ink widths within 60% at matched ratio', delta < 0.6,
          `vf=${vfWidth.toFixed(1)}px svg=${svgW.toFixed(1)}px Δ=${(delta * 100).toFixed(1)}%`);
      } else {
        record('parity', 'IN-RUNTIME', 'VF↔SVG parity measured', false, 'missing width sample');
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  const runtime = results.filter((r) => r.kind === 'IN-RUNTIME' || r.kind === 'PIXEL');
  const failed = runtime.filter((r) => !r.ok);
  const shots = results.filter((r) => r.kind === 'BY-INSPECTION');
  console.log('\n─────────────────────────────────────────────');
  console.log(`IN-RUNTIME: ${results.filter((r) => r.kind === 'IN-RUNTIME' && r.ok).length}/${results.filter((r) => r.kind === 'IN-RUNTIME').length} passed`);
  console.log(`PIXEL: ${results.filter((r) => r.kind === 'PIXEL' && r.ok).length}/${results.filter((r) => r.kind === 'PIXEL').length} passed`);
  console.log(`BY-INSPECTION: ${shots.length} screenshots in harness/screenshots/`);
  if (failed.length) {
    console.log(`FAILED: ${failed.map((f) => `${f.scenario}/${f.name}`).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('all in-runtime assertions passed ✓');
  }
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
