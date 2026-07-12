/**
 * test-invariants.mjs — verification for the Fontuccine math core.
 * Run: node test-invariants.mjs
 *
 * Invariants (these seed the QA agent's regression suite):
 *  I1  Total extent: remap(max) - remap(min) == W * stretch
 *  I2  Monotonicity: remap preserves order (no fold-overs)
 *  I3  Stroke preservation: perpendicular strokes/caps keep ~original size
 *  I4  Stretch localization: aligned/empty zones absorb the extra space
 *  I5  Compression never inverts geometry
 *  I6  Fully-rigid glyph degrades to uniform scaling (Pagurek's observation)
 *
 * History note: v1 of the analysis core bucketed boundary samples by axis
 * coordinate; THESE TESTS FALSIFIED IT (a solid stem read the distant caps'
 * aligned tangents and stretched 3×). The interior nearest-boundary-tangent
 * field is required. Keep these tests red-team-shaped.
 */
import { sampleOutline, computeFlexProfile, sampleBounds } from './01-flex-profile.mjs';
import { buildRemap } from './02-lut-remap.mjs';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else { console.error(`  ✘ ${name} ${detail}`); failures++; }
}
const approx = (a, b, tol) => Math.abs(a - b) <= tol;

// Synthetic glyph 1: solid rectangle bar, x∈[0,100], y∈[0,700] (a sans 'I').
const rect = [
  { type: 'M', x: 0, y: 0 },
  { type: 'L', x: 100, y: 0 },
  { type: 'L', x: 100, y: 700 },
  { type: 'L', x: 0, y: 700 },
  { type: 'Z' },
];

// Synthetic glyph 2: two vertical stems (an 'H' minus crossbar),
// x∈[0,100] and x∈[400,500], y∈[0,700].
const stems = [
  { type: 'M', x: 0, y: 0 }, { type: 'L', x: 100, y: 0 },
  { type: 'L', x: 100, y: 700 }, { type: 'L', x: 0, y: 700 }, { type: 'Z' },
  { type: 'M', x: 400, y: 0 }, { type: 'L', x: 500, y: 0 },
  { type: 'L', x: 500, y: 700 }, { type: 'L', x: 400, y: 700 }, { type: 'Z' },
];

function analyze(commands, axis, opts = {}) {
  const outline = sampleOutline(commands, 32);
  const bb = sampleBounds(outline);
  const bounds = axis === 'x' ? { min: bb.minX, max: bb.maxX } : { min: bb.minY, max: bb.maxY };
  const crossBounds = axis === 'x' ? { min: bb.minY, max: bb.maxY } : { min: bb.minX, max: bb.maxX };
  const flex = computeFlexProfile(outline, {
    axis, slices: 100, k: 8, bounds, crossBounds, interiorSamples: 64, ...opts,
  });
  return { flex, bounds };
}

console.log('— Bar ⟂ to stretch (horizontal stretch of a vertical bar, 2×) —');
{
  // The entire bar is a perpendicular stroke → everything rigid → the
  // correct degradation is UNIFORM scaling, not selective stretch.
  const { flex, bounds } = analyze(rect, 'x');
  const { remap } = buildRemap(flex, { ...bounds, stretch: 2 });
  const W = bounds.max - bounds.min;

  check('I1 total extent', approx(remap(bounds.max) - remap(bounds.min), W * 2, 1e-6));
  check('I6 stroke-only glyph → ~uniform', approx(remap(55) - remap(45), 20, 2.5),
    `middle 10u → ${(remap(55) - remap(45)).toFixed(2)} (want ≈20)`);
}

console.log('— Bar ∥ to stretch (vertical stretch of the same bar, 2×) —');
{
  // Stem elongation: caps (top/bottom ~50u, where cap edges are nearest)
  // stay rigid; the shaft absorbs the stretch. This is the AE behaviour.
  const { flex, bounds } = analyze(rect, 'y');
  const stretch = 2.0;
  const { remap } = buildRemap(flex, { ...bounds, stretch });

  check('I1 total extent', approx(remap(700) - remap(0), 700 * stretch, 1e-6));

  let monotonic = true, prev = -Infinity;
  for (let y = 0; y <= 700; y += 1) {
    const v = remap(y);
    if (v < prev - 1e-9) { monotonic = false; break; }
    prev = v;
  }
  check('I2 monotonic', monotonic);

  const bottomCap = remap(40) - remap(0);
  const topCap = remap(700) - remap(660);
  check('I3 bottom cap preserved', bottomCap < 40 * 1.35, `40u → ${bottomCap.toFixed(1)}`);
  check('I3 top cap preserved', topCap < 40 * 1.35, `40u → ${topCap.toFixed(1)}`);

  const shaft = remap(400) - remap(300);
  check('I4 shaft absorbs stretch', shaft > 100 * 1.7, `100u → ${shaft.toFixed(1)}`);
}

console.log('— Twin stems, horizontal stretch 3× —');
{
  const { flex, bounds } = analyze(stems, 'x');
  const stretch = 3.0;
  const { remap } = buildRemap(flex, { ...bounds, stretch });

  check('I1 total extent', approx(remap(500) - remap(0), 500 * stretch, 1e-6));

  // Stems are perpendicular strokes → must keep ~their thickness.
  const stem1 = remap(98) - remap(2);
  const stem2 = remap(498) - remap(402);
  check('I3 stem 1 thickness preserved', stem1 < 96 * 1.35, `96u → ${stem1.toFixed(1)}`);
  check('I3 stem 2 thickness preserved', stem2 < 96 * 1.35, `96u → ${stem2.toFixed(1)}`);

  // Empty gap x∈[100,400] must absorb nearly all E = 500·2 = 1000 extra u.
  const gap = remap(400) - remap(100);
  check('I4 gap absorbs stretch', gap > 300 + 1000 * 0.7, `300u → ${gap.toFixed(1)}`);
}

console.log('— Compression 0.5× (perpendicular bar) —');
{
  const { flex, bounds } = analyze(rect, 'x');
  const { remap, boundaries } = buildRemap(flex, { ...bounds, stretch: 0.5 });
  let inverted = false;
  for (let i = 1; i < boundaries.length; i++) {
    if (boundaries[i] - boundaries[i - 1] <= 0) { inverted = true; break; }
  }
  check('I5 no inversion under compression', !inverted);
  check('I5 total extent halved',
    approx(remap(bounds.max) - remap(bounds.min), (bounds.max - bounds.min) * 0.5, 1e-3));
}

console.log('— Fully rigid profile degrades to uniform —');
{
  const flex = new Float32Array(50).fill(0);
  const { remap } = buildRemap(flex, { min: 0, max: 100, stretch: 2 });
  check('I6 uniform fallback', approx(remap(50), 100, 1e-6), `remap(50)=${remap(50)}`);
  check('I6 total extent kept', approx(remap(100), 200, 1e-6));
}

console.log('— Normalized GPU LUT —');
{
  const { flex, bounds } = analyze(stems, 'x');
  const r = buildRemap(flex, { ...bounds, stretch: 2 });
  const lut = r.toNormalizedLUT();
  check('LUT starts at 0 / ends at 1', lut[0] === 0 && approx(lut[lut.length - 1], 1, 1e-6));
  let mono = true;
  for (let i = 1; i < lut.length; i++) if (lut[i] < lut[i - 1]) { mono = false; break; }
  check('LUT monotonic (GPU-safe)', mono);
}

console.log(failures === 0 ? '\nALL INVARIANTS PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
