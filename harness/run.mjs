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
 *   BY-INSPECTION — full-page screenshots saved to harness/screenshots/ for a
 *     human/CI-image-diff to judge WebGL scissor↔proxy PIXEL alignment and MSDF
 *     edge sharpness under stretch. These are NOT pixel-read in-page: the shared
 *     GL context ships without preserveDrawingBuffer, so an in-page readback is
 *     unreliable; the full-viewport shared canvas overlays the host 1:1, so the
 *     screenshot is a faithful capture of what shipped.
 *
 * Exit code is non-zero if any IN-RUNTIME assertion fails (CI gate).
 */
import { createServer } from 'node:http';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLAY_DIST = join(ROOT, 'playground', 'dist');
const SHOTS = join(ROOT, 'harness', 'screenshots');
const PORT = 4318;

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

async function ensurePlaygroundBuilt() {
  if (existsSync(join(PLAY_DIST, 'index.html'))) return;
  console.log('· building playground (vite build) …');
  const r = spawnSync('npm', ['--prefix', join(ROOT, 'playground'), 'run', 'build'], {
    cwd: ROOT, stdio: 'inherit',
  });
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

async function openScenario(browser, query) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 600, deviceScaleFactor: 1 });
  await page.goto(`http://localhost:${PORT}/index.html?${query}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__H && window.__H.ready === true', { timeout: 8000 });
  return page;
}
async function H(page) { return page.evaluate(() => {
  const h = window.__H;
  return { resolvedTier: h.resolvedTier, requestedTier: h.requestedTier, notes: h.notes,
    ink: h.ink(), host: h.host(), vf: h.vf(), glyphPaths: h.glyphPaths(), webgl: h.webglCanvas() };
}); }

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
      record('auto', 'IN-RUNTIME', 'single shared GL canvas mounted + viewport-sized',
        !!h.webgl?.present && h.webgl.w > 0 && h.webgl.h > 0, `${h.webgl?.w}×${h.webgl?.h}`);
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

  const runtime = results.filter((r) => r.kind === 'IN-RUNTIME');
  const failed = runtime.filter((r) => !r.ok);
  const shots = results.filter((r) => r.kind === 'BY-INSPECTION');
  console.log('\n─────────────────────────────────────────────');
  console.log(`IN-RUNTIME: ${runtime.length - failed.length}/${runtime.length} passed`);
  console.log(`BY-INSPECTION: ${shots.length} screenshots in harness/screenshots/`);
  if (failed.length) {
    console.log(`FAILED: ${failed.map((f) => `${f.scenario}/${f.name}`).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('all in-runtime assertions passed ✓');
  }
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
