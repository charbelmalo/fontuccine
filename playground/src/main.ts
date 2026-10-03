/**
 * main.ts — the Fontuccine playground.
 *
 * Two views:
 *  - Single: one target, every config parameter live-tweakable; on any change the
 *    instance is destroyed + re-attached (proving clean teardown by inspection).
 *  - Tier comparison: the SAME text/config rendered by all four tiers side by side
 *    (auto/webgl/svg/vf), one shared manual slider driving them via `.set()`. This
 *    doubles as the QA visual harness surface.
 *
 * A `?harness=…` query switches to a deterministic headless mode (see harness.ts)
 * so the puppeteer matrix can drive exact scenarios and read back measurements.
 */
import { Fontuccine } from 'fontuccine';
import type { FontuccineConfig, Instance } from 'fontuccine';
import { mountHarness } from './harness.ts';

// Served from public/ at the site root (works in `vite dev`, `build`, and the
// harness static server). Root-absolute so it resolves the same everywhere.
const FONT_TTF = '/fonts/RobotoFlex-VF.ttf';

// ── config state (mirrors the README public schema) ─────────────────────────
interface UIState extends FontuccineConfig {
  text: string;
  manual: number; // drives instance.set() when trigger === 'custom'
}

const state: UIState = {
  text: 'Stretchy',
  axis: 'horizontal',
  trigger: 'custom',
  // Default fits Roboto Flex's wdth axis (25–151%) so the comparison view demos
  // ALL FOUR tiers out of the box, incl. genuine Tier-0 VF. Crank maxStretchRatio
  // past 1.51 and watch the VF cell honestly fall through to WebGL/SVG (its range
  // exceeds what the type designer drew — vf/probe.ts).
  maxStretchRatio: 1.5,
  minStretchRatio: 1,
  edgeProtection: 8,
  lutResolution: 96,
  physics: { stiffness: 140, damping: 22 },
  proximityRadius: 240,
  velocityToStretch: 0.002,
  tier: 'auto',
  wrap: 'nowrap',
  reserveBasis: 'tier-capability',
  respectReducedMotion: true,
  effects: { grain: 0, aberration: { max: 0, fromVelocity: true } },
  manual: 1.45,
  fontUrl: FONT_TTF,
};

function cfg(overrides: Partial<FontuccineConfig> = {}): FontuccineConfig {
  const { manual: _m, text, ...rest } = state;
  return { ...rest, text, ...overrides };
}

// ── control schema → DOM ─────────────────────────────────────────────────────
type Ctl =
  | { kind: 'range'; key: string; label: string; min: number; max: number; step: number; get: () => number; set: (v: number) => void }
  | { kind: 'select'; key: string; label: string; options: string[]; get: () => string; set: (v: string) => void }
  | { kind: 'check'; key: string; label: string; get: () => boolean; set: (v: boolean) => void }
  | { kind: 'text'; key: string; label: string; get: () => string; set: (v: string) => void }
  | { kind: 'title'; label: string };

const controls: Ctl[] = [
  { kind: 'title', label: 'Content' },
  { kind: 'text', key: 'text', label: 'text', get: () => state.text, set: (v) => (state.text = v || ' ') },
  { kind: 'text', key: 'fontUrl', label: 'font URL (.ttf/.otf)', get: () => state.fontUrl ?? '', set: (v) => (state.fontUrl = v || FONT_TTF) },

  { kind: 'title', label: 'Stretch' },
  { kind: 'select', key: 'axis', label: 'axis', options: ['horizontal', 'vertical', 'dual'], get: () => state.axis!, set: (v) => (state.axis = v as UIState['axis']) },
  { kind: 'range', key: 'maxStretchRatio', label: 'maxStretchRatio', min: 1, max: 6, step: 0.1, get: () => state.maxStretchRatio!, set: (v) => (state.maxStretchRatio = v) },
  { kind: 'range', key: 'minStretchRatio', label: 'minStretchRatio', min: 0.5, max: 1, step: 0.05, get: () => state.minStretchRatio!, set: (v) => (state.minStretchRatio = v) },
  { kind: 'range', key: 'edgeProtection', label: 'edgeProtection (k)', min: 0, max: 24, step: 1, get: () => state.edgeProtection!, set: (v) => (state.edgeProtection = v) },
  { kind: 'range', key: 'lutResolution', label: 'lutResolution', min: 16, max: 160, step: 8, get: () => state.lutResolution!, set: (v) => (state.lutResolution = v) },

  { kind: 'title', label: 'Trigger & motion' },
  { kind: 'select', key: 'trigger', label: 'trigger', options: ['custom', 'hover', 'mouse-proximity', 'scroll-velocity'], get: () => state.trigger!, set: (v) => (state.trigger = v as UIState['trigger']) },
  { kind: 'range', key: 'manual', label: 'manual .set() (custom)', min: 0.5, max: 6, step: 0.05, get: () => state.manual, set: (v) => (state.manual = v) },
  { kind: 'range', key: 'stiffness', label: 'spring stiffness', min: 20, max: 400, step: 5, get: () => state.physics!.stiffness!, set: (v) => (state.physics = { ...state.physics, stiffness: v }) },
  { kind: 'range', key: 'damping', label: 'spring damping', min: 4, max: 60, step: 1, get: () => state.physics!.damping!, set: (v) => (state.physics = { ...state.physics, damping: v }) },
  { kind: 'range', key: 'proximityRadius', label: 'proximityRadius', min: 40, max: 600, step: 10, get: () => state.proximityRadius!, set: (v) => (state.proximityRadius = v) },
  { kind: 'range', key: 'velocityToStretch', label: 'velocityToStretch', min: 0, max: 0.01, step: 0.0005, get: () => state.velocityToStretch!, set: (v) => (state.velocityToStretch = v) },

  { kind: 'title', label: 'Tier & layout' },
  { kind: 'select', key: 'tier', label: 'tier', options: ['auto', 'webgl', 'svg', 'vf'], get: () => state.tier!, set: (v) => (state.tier = v as UIState['tier']) },
  { kind: 'select', key: 'wrap', label: 'wrap', options: ['nowrap', 'reserve'], get: () => state.wrap!, set: (v) => (state.wrap = v as UIState['wrap']) },
  { kind: 'select', key: 'reserveBasis', label: 'reserveBasis', options: ['tier-capability', 'uniform'], get: () => state.reserveBasis!, set: (v) => (state.reserveBasis = v as UIState['reserveBasis']) },
  { kind: 'check', key: 'respectReducedMotion', label: 'respectReducedMotion', get: () => !!state.respectReducedMotion, set: (v) => (state.respectReducedMotion = v) },

  { kind: 'title', label: 'Effects (WebGL / Tier 1 only)' },
  { kind: 'range', key: 'grain', label: 'grain', min: 0, max: 0.6, step: 0.01, get: () => state.effects!.grain ?? 0, set: (v) => (state.effects = { ...state.effects, grain: v }) },
  { kind: 'range', key: 'aberration', label: 'aberration max', min: 0, max: 6, step: 0.1, get: () => state.effects!.aberration?.max ?? 0, set: (v) => (state.effects = { ...state.effects, aberration: { max: v, fromVelocity: true } }) },
];

function renderControls(root: HTMLElement, onChange: (key: string) => void) {
  root.innerHTML = '';
  for (const c of controls) {
    if (c.kind === 'title') {
      const h = document.createElement('div');
      h.className = 'group-title';
      h.textContent = c.label;
      root.appendChild(h);
      continue;
    }
    const wrap = document.createElement('div');
    wrap.className = c.kind === 'check' ? 'field row' : 'field';
    if (c.kind === 'range') {
      const val = document.createElement('b');
      const lab = document.createElement('label');
      lab.innerHTML = `<span>${c.label}</span>`;
      val.textContent = String(c.get());
      lab.appendChild(val);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(c.min); input.max = String(c.max); input.step = String(c.step);
      input.value = String(c.get());
      input.oninput = () => { c.set(parseFloat(input.value)); val.textContent = input.value; onChange(c.key); };
      wrap.append(lab, input);
    } else if (c.kind === 'select') {
      const lab = document.createElement('label'); lab.innerHTML = `<span>${c.label}</span>`;
      const sel = document.createElement('select');
      for (const o of c.options) { const opt = document.createElement('option'); opt.value = o; opt.textContent = o; sel.appendChild(opt); }
      sel.value = c.get();
      sel.onchange = () => { c.set(sel.value); onChange(c.key); };
      wrap.append(lab, sel);
    } else if (c.kind === 'check') {
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = c.get();
      const lab = document.createElement('label'); lab.innerHTML = `<span>${c.label}</span>`;
      input.onchange = () => { c.set(input.checked); onChange(c.key); };
      wrap.append(input, lab);
    } else {
      const lab = document.createElement('label'); lab.innerHTML = `<span>${c.label}</span>`;
      const input = document.createElement('input'); input.type = 'text'; input.value = c.get();
      input.onchange = () => { c.set(input.value); onChange(c.key); };
      wrap.append(lab, input);
    }
    root.appendChild(wrap);
  }
}

// ── single view ──────────────────────────────────────────────────────────────
let single: Instance | null = null;
async function rebuildSingle() {
  const hero = document.getElementById('hero') as HTMLElement;
  single?.destroy();
  hero.textContent = state.text;
  const inst = (single = Fontuccine.attach(hero, cfg()));
  await inst.ready;
  if (inst !== single) return; // superseded by a newer rebuild while loading
  (document.getElementById('tier-badge') as HTMLElement).textContent = inst.tier ?? '—';
  (document.getElementById('notes') as HTMLElement).textContent = inst.notes.join('\n') || '(no notes)';
  if (state.trigger === 'custom') inst.set(state.manual);
}

// ── comparison view ──────────────────────────────────────────────────────────
const cmpInstances = new Map<string, Instance>();
async function rebuildCompare() {
  for (const [, inst] of cmpInstances) inst.destroy();
  cmpInstances.clear();
  for (const tier of ['auto', 'webgl', 'svg', 'vf'] as const) {
    const host = document.querySelector(`[data-cmp="${tier}"]`) as HTMLElement;
    host.textContent = state.text;
    const inst = Fontuccine.attach(host, cfg({ tier, trigger: 'custom' }));
    cmpInstances.set(tier, inst);
    inst.ready.then(() => {
      const badge = document.querySelector(`[data-badge="${tier}"]`) as HTMLElement;
      badge.textContent = inst.tier ?? '—';
      badge.title = inst.notes.join('\n');
      inst.set(state.manual);
    });
  }
}

function driveCompare() {
  for (const [, inst] of cmpInstances) inst.set(state.manual);
}

// ── mode switching ───────────────────────────────────────────────────────────
let mode: 'single' | 'compare' = 'single';
function applyMode() {
  (document.getElementById('single') as HTMLElement).hidden = mode !== 'single';
  (document.getElementById('compare') as HTMLElement).hidden = mode !== 'compare';
  for (const b of document.querySelectorAll<HTMLButtonElement>('.modes button'))
    b.classList.toggle('active', b.dataset.mode === mode);
  // Tear down the view being left so its instances (and WebGL surfaces) don't
  // keep running hidden underneath the visible one.
  if (mode === 'single') {
    for (const [, inst] of cmpInstances) inst.destroy();
    cmpInstances.clear();
    void rebuildSingle();
  } else {
    single?.destroy();
    single = null;
    void rebuildCompare();
  }
}

function onChange(key: string) {
  // manual slider is cheap — just drive; everything else re-attaches.
  if (key === 'manual') {
    if (mode === 'single') single?.set(state.manual);
    else driveCompare();
  } else if (mode === 'single') {
    void rebuildSingle();
  } else {
    void rebuildCompare();
  }
}

function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('harness') != null) {
    void mountHarness(params, FONT_TTF);
    return;
  }
  renderControls(document.getElementById('controls') as HTMLElement, onChange);
  for (const b of document.querySelectorAll<HTMLButtonElement>('.modes button'))
    b.onclick = () => { mode = b.dataset.mode as typeof mode; applyMode(); };
  applyMode();
}

boot();
