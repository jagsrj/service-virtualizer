// Fit a latency profile to observed response times (from a recording, a JMeter JTL,
// or an APM export). Uses quantile matching on p50 and p95, because those are the
// numbers performance engineers check, and reports how well the fit holds at p90/p99.
import { Z, expectedPercentiles, parseProfile } from './profiles.js';
import { percentile } from './stats.js';

export const MIN_SAMPLES = 20;

export function fitProfile(name, samplesMs, { description } = {}) {
  const clean = samplesMs.filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  if (clean.length === 0) throw new Error('No valid latency samples to fit');
  const sorted = [...clean].sort((a, b) => a - b);
  const observed = {
    p50: Math.round(percentile(sorted, 0.5)),
    p90: Math.round(percentile(sorted, 0.9)),
    p95: Math.round(percentile(sorted, 0.95)),
    p99: Math.round(percentile(sorted, 0.99)),
    max: Math.round(sorted.at(-1))
  };

  const warnings = [];
  if (clean.length < MIN_SAMPLES) {
    warnings.push(`Only ${clean.length} samples; percentiles (especially p95/p99) are unreliable below ${MIN_SAMPLES}`);
  }
  if (clean.length < samplesMs.length) warnings.push(`${samplesMs.length - clean.length} invalid samples ignored`);

  let latency;
  const p50 = Math.max(observed.p50, 1);
  // A tail less than ~5% above the median is effectively constant latency.
  if (observed.p95 <= p50 * 1.05) {
    latency = { type: 'fixed', ms: observed.p50 };
  } else {
    const sigma = Math.log(observed.p95 / p50) / Z.p95;
    latency = {
      type: 'lognormal',
      p50Ms: p50,
      sigma: Math.round(sigma * 10000) / 10000,
      capMs: Math.max(observed.max, observed.p95 + 1)
    };
  }

  const profile = parseProfile({
    name,
    description: description ?? `Fitted from ${clean.length} samples on ${new Date().toISOString().slice(0, 10)}`,
    latency
  });
  const fitted = expectedPercentiles(profile.latency);
  const errorPct = (a, b) => (b === 0 ? 0 : Math.round(((a - b) / b) * 1000) / 10);

  return {
    profile,
    samples: clean.length,
    observedMs: observed,
    fittedMs: fitted,
    fitErrorPct: { p90: errorPct(fitted.p90, observed.p90), p99: errorPct(fitted.p99, observed.p99) },
    warnings: [...warnings, ...tailWarnings(fitted, observed)]
  };
}

function tailWarnings(fitted, observed) {
  const off = Math.abs(fitted.p99 - observed.p99) / Math.max(observed.p99, 1);
  if (off <= 0.25) return [];
  return [
    `Fitted p99 (${fitted.p99}ms) differs from observed p99 (${observed.p99}ms) by ${Math.round(off * 100)}%. ` +
      'The real tail is not lognormal-shaped (often a bimodal cache hit/miss pattern); review before relying on p99.'
  ];
}
