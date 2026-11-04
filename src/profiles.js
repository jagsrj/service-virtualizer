// Latency and fault profiles: load them from YAML, validate them, and turn them into
// WireMock response settings.
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

// Standard normal quantiles used to convert percentiles to a lognormal sigma.
export const Z = { p50: 0, p90: 1.2816, p95: 1.6449, p99: 2.3263 };

export const FAULTS = [
  'CONNECTION_RESET_BY_PEER',
  'EMPTY_RESPONSE',
  'MALFORMED_RESPONSE_CHUNK',
  'RANDOM_DATA_THEN_CLOSE'
];

const ms = z.number().int().nonnegative();
const positiveMs = z.number().positive();

const latencySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('fixed'), ms }).strict(),
  z.object({ type: z.literal('uniform'), minMs: ms, maxMs: ms }).strict(),
  z
    .object({
      type: z.literal('lognormal'),
      p50Ms: positiveMs,
      p95Ms: positiveMs.optional(),
      p99Ms: positiveMs.optional(),
      sigma: z.number().positive().optional(),
      capMs: positiveMs.optional()
    })
    .strict()
]);

const errorResponseSchema = z
  .object({
    status: z.number().int().min(100).max(599).optional(),
    body: z.string().optional(),
    fault: z.enum(FAULTS).optional(),
    latencyMs: ms.optional(),
    weight: z.number().positive().default(1)
  })
  .strict()
  .refine((r) => (r.status === undefined) !== (r.fault === undefined), {
    message: 'each error response needs exactly one of status or fault'
  })
  .refine((r) => !(r.fault && r.body !== undefined), { message: 'body cannot be used with fault' });

const errorsSchema = z
  .object({
    rate: z.number().gt(0).max(1),
    responses: z.array(errorResponseSchema).min(1)
  })
  .strict();

const concurrencySchema = z
  .object({
    maxConcurrent: z.number().int().min(1),
    maxQueue: z.number().int().min(0).optional(),
    queueTimeoutMs: ms.optional(),
    reject: z
      .object({ status: z.number().int().min(100).max(599).default(503), body: z.string().optional() })
      .strict()
      .optional()
  })
  .strict();

// The service-virtualizer WireMock extension (see extension/) handles errors and concurrency.
export const SV_TRANSFORMER = 'sv';

export const profileSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'use lowercase letters, digits and dashes'),
    description: z.string().optional(),
    latency: latencySchema.default({ type: 'none' }),
    dribble: z
      .object({ chunks: z.number().int().min(1), durationMs: ms })
      .strict()
      .optional(),
    status: z.number().int().min(100).max(599).optional(),
    body: z.string().optional(),
    fault: z.enum(FAULTS).optional(),
    errors: errorsSchema.optional(),
    concurrency: concurrencySchema.optional()
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.concurrency && p.fault) {
      ctx.addIssue({ code: 'custom', path: ['concurrency'], message: 'concurrency cannot be combined with fault' });
    }
    if (p.errors && (p.fault || p.dribble)) {
      ctx.addIssue({ code: 'custom', path: ['errors'], message: 'errors cannot be combined with fault or dribble' });
    }
    const l = p.latency;
    if (l.type === 'uniform' && l.minMs > l.maxMs) {
      ctx.addIssue({ code: 'custom', path: ['latency'], message: 'minMs must be <= maxMs' });
    }
    if (l.type === 'lognormal') {
      const given = ['p95Ms', 'p99Ms', 'sigma'].filter((k) => l[k] !== undefined);
      if (given.length !== 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['latency'],
          message: 'lognormal needs exactly one of p95Ms, p99Ms or sigma (plus p50Ms)'
        });
      }
      for (const k of ['p95Ms', 'p99Ms']) {
        if (l[k] !== undefined && l[k] <= l.p50Ms) {
          ctx.addIssue({ code: 'custom', path: ['latency', k], message: `${k} must be greater than p50Ms` });
        }
      }
      if (l.capMs !== undefined && l.capMs < l.p50Ms) {
        ctx.addIssue({ code: 'custom', path: ['latency', 'capMs'], message: 'capMs must be >= p50Ms' });
      }
    }
    if (p.fault && (p.status !== undefined || p.body !== undefined || p.dribble)) {
      ctx.addIssue({
        code: 'custom',
        path: ['fault'],
        message: 'fault cannot be combined with status, body or dribble'
      });
    }
  });

export function parseProfile(raw, source = 'profile') {
  const result = profileSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid ${source}: ${detail}`);
  }
  return result.data;
}

// Lognormal median and sigma from the percentiles a performance engineer actually knows.
export function lognormalParams(latency) {
  const median = latency.p50Ms;
  let sigma = latency.sigma;
  if (sigma === undefined && latency.p95Ms !== undefined) sigma = Math.log(latency.p95Ms / median) / Z.p95;
  if (sigma === undefined && latency.p99Ms !== undefined) sigma = Math.log(latency.p99Ms / median) / Z.p99;
  return { median, sigma: round(sigma, 4) };
}

// What the profile should produce, so people can sanity-check it before a test.
export function expectedPercentiles(latency) {
  switch (latency.type) {
    case 'none':
      return { p50: 0, p90: 0, p95: 0, p99: 0 };
    case 'fixed':
      return { p50: latency.ms, p90: latency.ms, p95: latency.ms, p99: latency.ms };
    case 'uniform': {
      const at = (q) => Math.round(latency.minMs + q * (latency.maxMs - latency.minMs));
      return { p50: at(0.5), p90: at(0.9), p95: at(0.95), p99: at(0.99) };
    }
    case 'lognormal': {
      const { median, sigma } = lognormalParams(latency);
      const at = (z) => {
        const v = Math.round(median * Math.exp(sigma * z));
        return latency.capMs !== undefined ? Math.min(v, latency.capMs) : v;
      };
      return { p50: at(Z.p50), p90: at(Z.p90), p95: at(Z.p95), p99: at(Z.p99) };
    }
  }
}

const SHAPING_KEYS = ['fixedDelayMilliseconds', 'delayDistribution', 'chunkedDribbleDelay', 'fault'];
const BODY_KEYS = ['body', 'jsonBody', 'base64Body', 'bodyFileName'];

// Build a WireMock response from the stub's original (baseline) response plus a profile.
// Always starts from the baseline, so profiles never stack on top of each other.
export function toWireMockResponse(baseline, profile, { service } = {}) {
  const response = structuredClone(baseline ?? {});
  for (const k of SHAPING_KEYS) delete response[k];

  if (profile.fault) {
    const faulted = { fault: profile.fault };
    applyLatency(faulted, profile.latency);
    return faulted;
  }

  if (profile.status !== undefined) response.status = profile.status;
  if (profile.body !== undefined) {
    for (const k of BODY_KEYS) delete response[k];
    response.body = profile.body;
  }
  applyLatency(response, profile.latency);
  if (profile.dribble) {
    response.chunkedDribbleDelay = {
      numberOfChunks: profile.dribble.chunks,
      totalDuration: profile.dribble.durationMs
    };
  }
  const svParams = {};
  if (profile.errors) svParams.svErrors = profile.errors;
  if (profile.concurrency) {
    const { maxConcurrent, maxQueue, queueTimeoutMs, reject } = profile.concurrency;
    svParams.svConcurrency = {
      pool: service ?? profile.name,
      maxConcurrent,
      ...(maxQueue !== undefined && { maxQueue }),
      ...(queueTimeoutMs !== undefined && { queueTimeoutMs }),
      rejectStatus: reject?.status ?? 503,
      ...(reject?.body !== undefined && { rejectBody: reject.body })
    };
  }
  if (Object.keys(svParams).length) {
    response.transformers = [...new Set([...(response.transformers ?? []), SV_TRANSFORMER])];
    response.transformerParameters = { ...response.transformerParameters, ...svParams };
  }
  return response;
}

function applyLatency(response, latency) {
  switch (latency.type) {
    case 'none':
      return;
    case 'fixed':
      response.fixedDelayMilliseconds = latency.ms;
      return;
    case 'uniform':
      response.delayDistribution = { type: 'uniform', lower: latency.minMs, upper: latency.maxMs };
      return;
    case 'lognormal': {
      const { median, sigma } = lognormalParams(latency);
      response.delayDistribution = { type: 'lognormal', median, sigma };
      if (latency.capMs !== undefined) response.delayDistribution.maxValue = latency.capMs;
      return;
    }
  }
}

export async function loadProfiles(dir) {
  const files = (await fs.readdir(dir)).filter((f) => /\.ya?ml$/i.test(f)).sort();
  const profiles = new Map();
  for (const file of files) {
    const text = await fs.readFile(path.join(dir, file), 'utf8');
    const profile = parseProfile(YAML.parse(text), `profile file ${file}`);
    if (profiles.has(profile.name)) throw new Error(`Duplicate profile name "${profile.name}" in ${file}`);
    profiles.set(profile.name, profile);
  }
  return profiles;
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
