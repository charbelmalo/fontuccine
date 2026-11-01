#!/usr/bin/env node
/** Capture the README comparison with the built public API and real Chrome.
 * No engine patches, renderer mocks, or core-math illustrations.
 * Usage: CHROME_PATH=/path/to/chrome node harness/capture-readme.mjs [--output DIR]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const outputAt = process.argv.indexOf('--output');
if (outputAt >= 0 && !process.argv[outputAt + 1]) throw Error('--output needs a directory');
const OUT = outputAt < 0 ? path.join(ROOT, 'demos') : path.resolve(process.argv[outputAt + 1]);
const TEXT = 'Stretch with intention';
const RATIO = 2.5, SIZE = 48, WEIGHT = 700, DPR = 2, HEIGHT = 390;
const FONT = 'playground/public/fonts/RobotoFlex-VF.ttf';
const ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--enable-webgl',
];
const chrome = [process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
].find(p => p && existsSync(p));
if (!chrome) throw Error('Chrome not found; set CHROME_PATH');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }).trim();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = async file => sha256(await readFile(path.join(ROOT, file)));

// Always rebuild the distributable; never capture a stale dist or alias source.
execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Fontuccine horizontal comparison</title><link rel="icon" href="data:,">
<script type="importmap">{"imports":{"opentype.js":"/opentype.js"}}</script>
<style>
@font-face { font-family: 'Capture Roboto Flex'; src: url('/font.ttf') format('truetype');
  font-weight: 100 1000; font-stretch: 25% 151%; font-display: block; }
* { box-sizing: border-box; }
html, body { margin: 0; background: white; color: #111; }
header { margin: 18px 20px 12px; height: 34px; font: 14px sans-serif; color: #555; }
.row { height: 106px; position: relative; padding-left: 220px; }
.label { position: absolute; top: 17px; left: 20px; font: 13px/1.5 monospace; color: #555; }
.sample { display: inline-block; margin: 0; white-space: nowrap;
  font-family: 'Capture Roboto Flex'; font-size: ${SIZE}px; font-weight: ${WEIGHT};
  font-style: normal; font-stretch: 100%; font-optical-sizing: auto;
  font-variation-settings: normal; line-height: 1.5; }
#scaled { transform: scaleX(${RATIO}); transform-origin: left center; }
</style>
<header>Roboto Flex · ${SIZE} px · weight ${WEIGHT} · horizontal stretch</header>
<div class="row"><span class="label">Native DOM text<br>1×</span><div class="sample" id="native">${TEXT}</div></div>
<div class="row"><span class="label">CSS scaleX(${RATIO})<br>${RATIO}×</span><div class="sample" id="scaled">${TEXT}</div></div>
<div class="row"><span class="label">Fontuccine WebGL<br>width plan · ${RATIO}×</span><div class="sample" id="rendered">${TEXT}</div></div>
</html>`;
// Only expose the assets this capture needs.
const routes = new Map([
  ['/font.ttf', [FONT, 'font/ttf']],
  ['/opentype.js', ['node_modules/opentype.js/dist/opentype.module.js', 'text/javascript']],
]);
for (const f of await readdir(path.join(ROOT, 'dist'))) {
  if (f.endsWith('.js')) routes.set('/dist/' + f, ['dist/' + f, 'text/javascript']);
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    const route = routes.get(url.pathname);
    if (!route) { res.writeHead(404).end(); return; }
    res.setHeader('content-type', route[1]);
    res.end(await readFile(path.join(ROOT, route[0])));
  } catch { res.writeHead(500).end(); }
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  browser = await puppeteer.launch({ executablePath: chrome, headless: 'shell', args: ARGS, protocolTimeout: 30000 });

  async function open(tier) {
    const page = await browser.newPage();
    const errors = [], warnings = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => {
      if (m.type() === 'error') errors.push(m.text());
      if (m.type() === 'warn') warnings.push(m.text());
    });
    await page.setViewport({ width: 1800, height: HEIGHT, deviceScaleFactor: DPR });
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.evaluate(async () => {
      const faces = await document.fonts.load('700 48px "Capture Roboto Flex"');
      if (faces.length !== 1 || faces[0].status !== 'loaded') throw Error('TTF face did not load');
      await document.fonts.ready;
    });
    const nativeWidth = await page.$eval('#native', el => el.getBoundingClientRect().width);
    const width = Math.ceil(220 + nativeWidth * RATIO + 40);
    await page.setViewport({ width, height: HEIGHT, deviceScaleFactor: DPR });
    assert.equal(await page.title(), 'Fontuccine horizontal comparison');
    assert.equal(await page.$('vite-error-overlay'), null);

    const cdp = await page.createCDPSession();
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#native' });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    assert.equal(fonts.length, 1, 'native text must not use fallback fonts');
    assert.equal(fonts[0].isCustomFont, true);
    assert.match(fonts[0].familyName, /Roboto Flex/);

    if (tier === 'webgl') {
      // A non-pausing CDP function breakpoint observes the actual plan passed by
      // attach(), including the parser's instanced locations. It changes no code.
      await cdp.send('Debugger.enable');
      const { result } = await cdp.send('Runtime.evaluate', {
        expression: 'import("/dist/webgl.js").then(m => m.createWebglRenderer)', awaitPromise: true,
      });
      assert.ok(result.objectId, 'public WebGL renderer function must resolve');
      await cdp.send('Debugger.setBreakpointOnFunctionCall', {
        objectId: result.objectId,
        condition: `(() => {
          const p = arguments[0].plan;
          window.__plan = p && {
            base: p.base, tracking: p.tracking,
            steps: p.steps.map(s => ({ width: s.width, location: s.location })),
            residualMeasure: p.steps.at(-1).glyphs.reduce((m, g) => m +
              (g.bounds.max - g.bounds.min) * g.weights.reduce((a,b) => a+b, 0) / g.weights.length +
              (g.bounds.max > g.bounds.min ? 0 : g.advanceWidth), 0) +
              (p.steps.at(-1).glyphs.length - 1) * p.tracking
          };
          return false;
        })()`,
      });
      await page.evaluate(() => {
        // Pass through the real GPU draw, recording its real shader uniforms.
        const proto = WebGL2RenderingContext.prototype;
        const draw = proto.drawElementsInstanced;
        proto.drawElementsInstanced = function (...args) {
          const program = this.getParameter(this.CURRENT_PROGRAM);
          window.__gpu = Object.fromEntries(['u_growth', 'u_instMix'].map(name =>
            [name, this.getUniform(program, this.getUniformLocation(program, name))]));
          return Reflect.apply(draw, this, args);
        };
      });
    }
    await page.evaluate(async tier => {
      const { Fontuccine } = await import('/dist/index.js');
      window.__instance = Fontuccine.attach('#rendered', {
        tier, fontUrl: '/font.ttf', axis: 'horizontal', trigger: 'custom',
        minStretchRatio: 1, maxStretchRatio: 2.5, respectReducedMotion: false,
        inkDilation: 'auto', easingCurve: 'cubic-bezier(0,0,1,1)', easingDuration: 0.1,
      });
      await window.__instance.ready;
    }, tier);
    const state = await page.evaluate(() => ({ tier: window.__instance.tier, notes: [...window.__instance.notes] }));
    assert.equal(state.tier, tier, JSON.stringify(state));
    assert.deepEqual(state.notes, [], 'no renderer, font, worker, or calibration fallback');
    const clip = await page.$eval('#rendered', el => {
      const r = el.getBoundingClientRect();
      return { x: r.x - 8, y: r.y - 4, width: innerWidth - r.x - 8, height: r.height + 8 };
    });
    async function stableShot() {
      let previous, same = 0;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const png = await page.screenshot({ clip, captureBeyondViewport: false });
        const hash = sha256(png);
        same = hash === previous ? same + 1 : 0;
        if (same >= 3) return png;
        previous = hash; await delay(200);
      }
      throw Error('renderer pixels did not settle');
    }
    const before = await stableShot();
    await page.evaluate(ratio => window.__instance.set(ratio), RATIO);
    // Wait for the requested frame to reach the real GPU, not merely set().
    if (tier === 'webgl') await page.waitForFunction(ratio => {
      const p = window.__plan;
      const expected = (p.steps[p.base].width * ratio - p.steps.at(-1).width) / p.residualMeasure;
      return Math.abs(window.__gpu?.u_growth - expected) < 0.00001;
    }, { timeout: 30000 }, RATIO).catch(async error => {
      const observed = await page.evaluate(() => ({ plan: window.__plan, gpu: window.__gpu,
        notes: window.__instance.notes, text: document.querySelector('#rendered').outerHTML }));
      throw Error('Target GPU frame did not arrive: ' + JSON.stringify(observed), { cause: error });
    });
    else await delay(1000);
    const after = await stableShot();
    assert.notEqual(sha256(before), sha256(after), 'specimen pixels must change from 1× to 2.5×');
    const evidence = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('#native'));
      const c = document.querySelector('#rendered canvas[data-fontuccine="webgl-surface"]');
      return {
        style: Object.fromEntries(['fontFamily', 'fontSize', 'fontWeight', 'fontStretch', 'fontStyle',
          'fontOpticalSizing', 'fontVariationSettings'].map(k => [k, cs[k]])),
        canvas: c && { width: c.width, height: c.height, inHost: c.parentElement.closest('#rendered') !== null },
        plan: window.__plan, gpu: window.__gpu,
        nativeWidth: document.querySelector('#native').getBoundingClientRect().width,
        cssScaledWidth: document.querySelector('#scaled').getBoundingClientRect().width,
        overflow: document.documentElement.scrollWidth > innerWidth,
        glRenderer: (() => {
          const gl = document.querySelector('canvas[data-fontuccine="webgl-shared"]')?.getContext('webgl2');
          const ext = gl?.getExtension('WEBGL_debug_renderer_info');
          return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
        })(),
      };
    });
    assert.equal(evidence.overflow, false);
    assert.ok(Math.abs(evidence.cssScaledWidth / evidence.nativeWidth - RATIO) < 0.001);
    assert.deepEqual(errors, []); assert.deepEqual(warnings, []);
    return { page, after, evidence: { ...state, ...evidence, fonts, errors, warnings }, viewport: { width, height: HEIGHT, deviceScaleFactor: DPR } };
  }

  const webgl = await open('webgl');
  const { plan, gpu, canvas } = webgl.evidence;
  assert.ok(canvas?.inHost && canvas.width > 0 && canvas.height > 0);
  assert.ok(plan?.steps.length > 1, 'attach must pass a real variable-font width ladder');
  const base = plan.steps[plan.base], last = plan.steps.at(-1);
  assert.equal(base.location.wght, WEIGHT); assert.equal(base.location.opsz, SIZE);
  assert.equal(base.location.wdth, 100);
  assert.ok(last.location.wdth > base.location.wdth);
  assert.ok(last.width < base.width * RATIO, 'this specimen must reach the residual stage');
  const expectedGrowth = (base.width * RATIO - last.width) / plan.residualMeasure;
  assert.ok(Math.abs(gpu.u_growth - expectedGrowth) < 0.00001, `real GPU must use the width-plan residual: actual=${gpu.u_growth}, expected=${expectedGrowth}`);
  assert.equal(gpu.u_instMix, 0);
  assert.ok(Math.abs(webgl.evidence.nativeWidth - base.width * SIZE / 1000) < 1, 'DOM and outline base widths must match');

  console.log(`· verified WebGL: ${plan.steps.length} instances; residual=${gpu.u_growth}`);
  const svg = await open('svg');
  assert.deepEqual(svg.viewport, webgl.viewport);
  // Same screenshot ink threshold as harness/run.mjs. Compare only the actual
  // specimen, excluding labels. No registration, rescaling, or image retouching.
  console.log('· comparing WebGL and SVG specimen screenshots');
  const comparePage = await browser.newPage();
  const pixels = await comparePage.evaluate(async ([a, b]) => {
    const mask = async png => {
      const im = new Image();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('PNG decode timed out')), 10000);
        im.onload = () => { clearTimeout(timer); resolve(); };
        im.onerror = () => { clearTimeout(timer); reject(Error('PNG decode failed')); };
        im.src = 'data:image/png;base64,' + png;
      });
      const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
      const ctx = c.getContext('2d'); ctx.drawImage(im, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      return { w: c.width, h: c.height, m: Uint8Array.from({ length: c.width * c.height }, (_, i) =>
        765 - d[i * 4] - d[i * 4 + 1] - d[i * 4 + 2] > 120 ? 1 : 0) };
    };
    const [aMask, bMask] = await Promise.all([mask(a), mask(b)]);
    if (aMask.w !== bMask.w || aMask.h !== bMask.h) throw Error('pixel dimensions differ');
    let inkWebgl = 0, inkSvg = 0, inter = 0, union = 0;
    for (let i = 0; i < aMask.m.length; i++) {
      const x = aMask.m[i], y = bMask.m[i];
      inkWebgl += x; inkSvg += y; inter += x && y; union += x || y;
    }
    return { width: aMask.w, height: aMask.h, inkWebgl, inkSvg, iou: inter / union };
  }, [Buffer.from(webgl.after).toString('base64'), Buffer.from(svg.after).toString('base64')]);
  await comparePage.close();
  assert.ok(pixels.inkWebgl > 1000 && pixels.inkSvg > 1000, 'both renderers must paint substantial ink');
  assert.ok(pixels.iou >= 0.93, `captured WebGL/SVG IoU ${pixels.iou} < 0.93`);

  // All checks pass before replacing the README asset and provenance.
  console.log(`· specimen pixel IoU=${pixels.iou.toFixed(4)}; saving comparison`);
  await webgl.page.bringToFront();
  const png = await webgl.page.screenshot({ captureBeyondViewport: false });
  const distHashes = Object.fromEntries(await Promise.all((await readdir(path.join(ROOT, 'dist')))
    .filter(f => f.endsWith('.js')).sort().map(async f => [f, await hashFile('dist/' + f)])));
  const report = {
    schemaVersion: 1, capturedAt: new Date().toISOString(),
    source: { revision: run('git', ['rev-parse', 'HEAD']), srcTree: run('git', ['rev-parse', 'HEAD:src']),
      sourceChanges: run('git', ['status', '--porcelain', '--', 'src', 'tsup.config.ts']), distSha256: distHashes },
    captureScriptSha256: await hashFile('harness/capture-readme.mjs'),
    ciRun: process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
    browser: await browser.version(), os: `${os.platform()} ${os.release()} ${os.arch()}`,
    node: process.version, launchArgs: ARGS, viewport: webgl.viewport,
    font: { path: FONT, sha256: await hashFile(FONT), license: 'playground/public/fonts/OFL.txt' },
    text: TEXT, axis: 'horizontal', ratio: RATIO, inkDilation: 'auto', effects: 'none',
    motion: { easingCurve: 'cubic-bezier(0,0,1,1)', easingDuration: 0.1 },
    webgl: webgl.evidence, svg: svg.evidence, pixels: { ...pixels, minimumIou: 0.93 },
    image: { path: 'demo-horizontal.png', sha256: sha256(png) },
    scope: 'Built public attach API in this checkout; one Roboto Flex TTF, horizontal WebGL at 2.5×. SVG is the pixel reference. No other modes, fonts, or browsers are established by this capture.',
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, 'demo-horizontal.png'), png);
  await writeFile(path.join(OUT, 'demo-horizontal.capture.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Captured ${webgl.viewport.width * DPR}×${HEIGHT * DPR}; WebGL/SVG IoU=${pixels.iou.toFixed(4)}; ${plan.steps.length} width instances; growth=${gpu.u_growth.toFixed(4)}`);
  console.log(`Image and provenance: ${OUT}`);
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
