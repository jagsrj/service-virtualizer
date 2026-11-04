import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expectedPercentiles,
  loadProfiles,
  lognormalParams,
  parseProfile,
  toWireMockResponse
} from '../src/profiles.js';
import { percentile } from '../src/stats.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('lognormal sigma is derived from p50 and p95', () => {
  const { median, sigma } = lognormalParams({ type: 'lognormal', p50Ms: 100, p95Ms: 200 });
  assert.equal(median, 100);
  assert.ok(Math.abs(sigma - Math.log(2) / 1.6449) < 1e-3);
  const expected = expectedPercentiles({ type: 'lognormal', p50Ms: 100, p95Ms: 200 });
  assert.equal(expected.p50, 100);
  assert.equal(expected.p95, 200);
});

test('lognormal cap limits the expected tail', () => {
  const expected = expectedPercentiles({ type: 'lognormal', p50Ms: 600, p95Ms: 2500, capMs: 3000 });
  assert.equal(expected.p99, 3000);
});

test('profiles are applied from the baseline, never stacked', () => {
  const baseline = { status: 200, jsonBody: { ok: true }, fixedDelayMilliseconds: 999 };
  const outage = parseProfile({ name: 'o', latency: { type: 'fixed', ms: 10 }, status: 503, body: 'down' });
  const r = toWireMockResponse(baseline, outage);
  assert.deepEqual(r, { status: 503, body: 'down', fixedDelayMilliseconds: 10 });
  assert.equal(baseline.fixedDelayMilliseconds, 999, 'baseline must not be mutated');
});

test('lognormal profile maps to a WireMock delay distribution with maxValue', () => {
  const p = parseProfile({ name: 'x', latency: { type: 'lognormal', p50Ms: 80, sigma: 0.5, capMs: 1000 } });
  const r = toWireMockResponse({ status: 200 }, p);
  assert.deepEqual(r.delayDistribution, { type: 'lognormal', median: 80, sigma: 0.5, maxValue: 1000 });
});

test('fault profile replaces the response but keeps latency', () => {
  const p = parseProfile({ name: 'f', latency: { type: 'fixed', ms: 200 }, fault: 'CONNECTION_RESET_BY_PEER' });
  assert.deepEqual(toWireMockResponse({ status: 200, body: 'x' }, p), {
    fault: 'CONNECTION_RESET_BY_PEER',
    fixedDelayMilliseconds: 200
  });
});

test('dribble maps to chunkedDribbleDelay', () => {
  const p = parseProfile({ name: 'd', dribble: { chunks: 4, durationMs: 2000 } });
  assert.deepEqual(toWireMockResponse({ status: 200 }, p).chunkedDribbleDelay, {
    numberOfChunks: 4,
    totalDuration: 2000
  });
});

test('invalid profiles are rejected with a clear message', () => {
  assert.throws(() => parseProfile({ name: 'Bad Name' }), /name/);
  assert.throws(() => parseProfile({ name: 'a', latency: { type: 'lognormal', p50Ms: 100 } }), /exactly one/);
  assert.throws(
    () => parseProfile({ name: 'a', latency: { type: 'lognormal', p50Ms: 100, p95Ms: 50 } }),
    /greater than p50Ms/
  );
  assert.throws(() => parseProfile({ name: 'a', latency: { type: 'uniform', minMs: 10, maxMs: 5 } }), /minMs/);
  assert.throws(() => parseProfile({ name: 'a', fault: 'EMPTY_RESPONSE', status: 500 }), /fault cannot/);
  assert.throws(() => parseProfile({ name: 'a', fault: 'NOPE' }), /fault/);
});

test('bundled profiles all load', async () => {
  const profiles = await loadProfiles(path.join(root, 'profiles'));
  assert.deepEqual([...profiles.keys()].sort(), [
    'brownout',
    'connection-reset',
    'degraded',
    'flaky',
    'healthy',
    'outage-503',
    'slow-drip'
  ]);
});

test('percentile uses nearest rank', () => {
  const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(s, 0.5), 5);
  assert.equal(percentile(s, 0.95), 10);
  assert.equal(percentile([], 0.5), null);
});

test('error profiles add the sv-errors transformer and keep existing ones', () => {
  const p = parseProfile({
    name: 'e',
    latency: { type: 'fixed', ms: 5 },
    errors: { rate: 0.05, responses: [{ status: 500 }, { fault: 'EMPTY_RESPONSE', weight: 2 }] }
  });
  const baseline = { status: 200, transformers: ['response-template'], transformerParameters: { a: 1 } };
  const r = toWireMockResponse(baseline, p);
  assert.deepEqual(r.transformers, ['response-template', 'sv-errors']);
  assert.equal(r.transformerParameters.a, 1);
  assert.deepEqual(r.transformerParameters.svErrors, {
    rate: 0.05,
    responses: [
      { status: 500, weight: 1 },
      { fault: 'EMPTY_RESPONSE', weight: 2 }
    ]
  });
  assert.deepEqual(baseline.transformers, ['response-template'], 'baseline must not be mutated');
  // Switching to a profile without errors removes the transformer again.
  assert.equal(toWireMockResponse(baseline, parseProfile({ name: 'h' })).transformers.includes('sv-errors'), false);
});

test('invalid error settings are rejected', () => {
  const bad =
    (errors, extra = {}) =>
    () =>
      parseProfile({ name: 'x', errors, ...extra });
  assert.throws(bad({ rate: 0, responses: [{ status: 500 }] }), /rate/);
  assert.throws(bad({ rate: 1.5, responses: [{ status: 500 }] }), /rate/);
  assert.throws(bad({ rate: 0.1, responses: [] }), /responses/);
  assert.throws(bad({ rate: 0.1, responses: [{ body: 'x' }] }), /exactly one of status or fault/);
  assert.throws(bad({ rate: 0.1, responses: [{ status: 500, fault: 'EMPTY_RESPONSE' }] }), /exactly one/);
  assert.throws(bad({ rate: 0.1, responses: [{ fault: 'EMPTY_RESPONSE', body: 'x' }] }), /body cannot/);
  assert.throws(bad({ rate: 0.1, responses: [{ status: 500 }] }, { fault: 'EMPTY_RESPONSE' }), /cannot be combined/);
});
