import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitProfile } from '../src/fit.js';

// Deterministic lognormal samples (seeded PRNG + Box-Muller).
function lognormalSamples(n, median, sigma, seed = 42) {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return (s + 1) / 4294967297;
  };
  return Array.from({ length: n }, () => {
    const z = Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());
    return median * Math.exp(sigma * z);
  });
}

test('recovers a lognormal distribution from samples', () => {
  const result = fitProfile('svc-recorded', lognormalSamples(20000, 120, 0.5));
  assert.equal(result.profile.latency.type, 'lognormal');
  assert.ok(Math.abs(result.profile.latency.p50Ms - 120) <= 5, `p50 ${result.profile.latency.p50Ms}`);
  assert.ok(Math.abs(result.profile.latency.sigma - 0.5) <= 0.03, `sigma ${result.profile.latency.sigma}`);
  assert.ok(Math.abs(result.fitErrorPct.p99) < 10);
  assert.deepEqual(result.warnings, []);
});

test('nearly constant latency becomes a fixed profile', () => {
  const result = fitProfile(
    'flat',
    Array.from({ length: 100 }, (_, i) => 50 + (i % 2))
  );
  assert.deepEqual(result.profile.latency, { type: 'fixed', ms: 50 });
});

test('cap is the largest observed latency', () => {
  const samples = lognormalSamples(1000, 100, 0.4);
  const result = fitProfile('capped', samples);
  assert.equal(result.profile.latency.capMs, Math.round(Math.max(...samples)));
});

test('warns about small samples and non-lognormal tails', () => {
  assert.match(fitProfile('few', [10, 20, 30]).warnings.join(), /Only 3 samples/);
  // Bimodal: 95% cache hits at ~10ms, 5% misses at ~900ms.
  const bimodal = [...Array(950).fill(10), ...Array(50).fill(900)].map((v, i) => v + (i % 7));
  assert.match(fitProfile('bimodal', bimodal).warnings.join(), /not lognormal-shaped/);
});

test('ignores invalid samples and rejects empty input', () => {
  const result = fitProfile('mixed', [...lognormalSamples(100, 50, 0.3), -1, NaN, 'x']);
  assert.equal(result.samples, 100);
  assert.match(result.warnings.join(), /3 invalid samples ignored/);
  assert.throws(() => fitProfile('none', []), /No valid latency samples/);
});
