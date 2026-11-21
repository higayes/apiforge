#!/usr/bin/env node
/**
 * Template-engine complexity benchmark.
 *
 * Reproducible check that `renderTemplate` grows linearly with input size, and
 * that adversarial shapes derived from CodeQL alert js/polynomial-redos cannot
 * make it backtrack catastrophically.
 *
 * Every shape below is fed at doubling sizes. The script prints the measured
 * time and the growth factor between consecutive sizes. A healthy linear
 * implementation shows a factor near 2; the pre-fix engine showed ~4 (quadratic)
 * and terminated the run by hanging for minutes at the largest sizes.
 *
 * Usage:
 *   node scripts/bench-template.mjs            # default sizes
 *   node scripts/bench-template.mjs --quick    # smaller sizes, for CI
 *
 * Exit code is 0 when every shape stays sub-quadratic, 1 otherwise.
 */
import { renderTemplate } from '../packages/engine/dist/util/template.js';

const QUICK = process.argv.includes('--quick');
// `--quick` still has to be large enough that the measured times clear timer
// noise; below a millisecond the ratio says nothing about the algorithm.
const SIZES = QUICK
  ? [50_000, 100_000, 200_000, 400_000]
  : [10_000, 20_000, 40_000, 80_000, 160_000];
const CTX = { variables: { a: 'A', b: 'B', name: 'Ada' }, secrets: {}, steps: {}, env: {} };

/**
 * Adversarial and realistic input shapes.
 * `gen(n)` must produce roughly `n` characters.
 */
const SHAPES = {
  'truncated opener (the old killer)': (n) => '{{{{' + ' '.repeat(n),
  'opener flood': (n) => '{{'.repeat(Math.floor(n / 2)),
  'unclosed opener + whitespace': (n) => '{{' + ' '.repeat(n),
  'unclosed with content': (n) => '{{a'.repeat(Math.floor(n / 3)),
  'alternating open/close': (n) => '{{ '.repeat(Math.floor(n / 6)) + '}}'.repeat(Math.floor(n / 6)),
  'many valid placeholders': (n) => '{{a}}'.repeat(Math.floor(n / 5)),
  'many whitespace-padded placeholders': (n) => '{{   a   }}'.repeat(Math.floor(n / 10)),
  'brace storm': (n) => '{}'.repeat(Math.floor(n / 2)),
  'single huge whitespace capture': (n) => '{{' + ' '.repeat(n) + '}}',
  'realistic mixed template': (n) =>
    'GET https://{{name}}.example.com/{{a}}/{{b}}?q={{a}}\n'.repeat(
      Math.max(1, Math.floor(n / 58)),
    ),
};

/** Median of 3 runs after one warm-up render, in milliseconds. */
function measure(input) {
  renderTemplate(input, CTX, { strict: false });
  const samples = [];
  for (let i = 0; i < 3; i += 1) {
    const start = process.hrtime.bigint();
    renderTemplate(input, CTX, { strict: false });
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((x, y) => x - y);
  return samples[1];
}

let failures = 0;
const rows = [];

for (const [name, gen] of Object.entries(SHAPES)) {
  const times = [];
  for (const n of SIZES) {
    const input = gen(n);
    const elapsed = measure(input);
    times.push({ n: input.length, ms: elapsed });
  }

  // Growth factor between consecutive doublings. A ratio is only meaningful
  // when both measurements are well above timer noise: for runs that finish in
  // tens of microseconds the ratio is dominated by scheduler jitter, not by the
  // algorithm. Such pairs are reported but excluded from the verdict.
  const NOISE_FLOOR_MS = 1;
  const factors = [];
  for (let i = 1; i < times.length; i += 1) {
    const prev = times[i - 1].ms;
    const cur = times[i].ms;
    const meaningful = prev >= NOISE_FLOOR_MS && cur >= NOISE_FLOOR_MS;
    factors.push({ value: cur / Math.max(prev, 1e-3), meaningful });
  }
  const measured = factors.filter((factor) => factor.meaningful);
  const worst = measured.length > 0 ? Math.max(...measured.map((f) => f.value)) : 0;
  const tooFastToJudge = measured.length === 0;
  // Quadratic would be ~4x per doubling; allow generous headroom for noise.
  const ok = tooFastToJudge || worst < 3;
  if (!ok) failures += 1;
  rows.push({ name, times, factors, worst, ok, tooFastToJudge });
}

const pct = (v) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a');
const pad = (s, n) => String(s).padEnd(n);

console.log(`\nTemplate engine complexity benchmark (Chunk ${process.version})`);
console.log(`Sizes: ${SIZES.map((n) => n.toLocaleString('en-US')).join(' → ')}\n`);
console.log(`${pad('shape', 40)}${pad('last (ms)', 12)}${pad('worst factor', 14)}verdict`);
console.log('-'.repeat(84));

for (const row of rows) {
  const last = row.times[row.times.length - 1];
  const verdict = row.tooFastToJudge
    ? 'ok (too fast to measure)'
    : row.ok
      ? 'ok (sub-quadratic)'
      : 'FAIL (super-quadratic)';
  const shown = row.tooFastToJudge ? 'n/a' : `${pct(row.worst)}x`;
  console.log(`${pad(row.name, 40)}${pad(pct(last.ms), 12)}${pad(shown, 14)}${verdict}`);
}

console.log('-'.repeat(84));
console.log(
  '\nGrowth factor is time(n+1)/time(n) between consecutive doublings.\n' +
    'Linear ≈ 2x, quadratic ≈ 4x. The pass threshold is < 3x.\n',
);

if (failures > 0) {
  console.error(`${failures} shape(s) grew super-quadratically.`);
  process.exit(1);
}
console.log('All shapes stayed sub-quadratic.');
