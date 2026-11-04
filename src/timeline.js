// Timelines: scheduled profile changes during a test, e.g. "degrade doc-verify at minute 5,
// recover at minute 7". Driven by perf-framework (start with the run) or chaos-runner
// (start as an experiment). One timeline runs at a time; timers live in this process.
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { HttpError } from './virtualizer.js';

const UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000 };

// "90s", "5m", "1h", "500ms", or a plain number of seconds.
export function parseDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value * 1000);
  const match = typeof value === 'string' && /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration "${value}" (use e.g. 30s, 5m, 1h or seconds as a number)`);
  return Math.round(Number(match[1]) * UNITS[match[2]]);
}

const stepSchema = z
  .object({
    at: z.union([z.number(), z.string()]),
    service: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    profile: z.string().optional(),
    reset: z.literal(true).optional()
  })
  .strict()
  .refine((s) => (s.profile === undefined) !== (s.reset === undefined), {
    message: 'each step needs exactly one of profile or reset: true'
  });

const timelineSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .default('adhoc'),
    description: z.string().optional(),
    steps: z.array(stepSchema).min(1).max(500)
  })
  .strict();

export class TimelineRunner {
  constructor({ virtualizer, timelinesDir }) {
    this.virtualizer = virtualizer;
    this.timelinesDir = timelinesDir;
    this.active = null;
  }

  async listFiles() {
    let files = [];
    try {
      files = (await fs.readdir(this.timelinesDir)).filter((f) => /\.ya?ml$/.test(f)).sort();
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      const t = parse(YAML.parse(await fs.readFile(path.join(this.timelinesDir, f), 'utf8')), f);
      out.push({ name: t.name, description: t.description ?? '', steps: t.steps.length });
    }
    return out;
  }

  current() {
    if (!this.active) return { running: false };
    const { name, startedAt, steps, state } = this.active;
    return {
      running: state === 'running',
      name,
      state,
      startedAt: new Date(startedAt).toISOString(),
      elapsedMs: Date.now() - startedAt,
      steps: steps.map(({ timer: _timer, ...s }) => s)
    };
  }

  // Start from { name } (a file in timelines/) or an inline { steps: [...] }.
  async start(body) {
    if (this.active?.state === 'running') {
      throw new HttpError(409, `Timeline "${this.active.name}" is already running; cancel it first`);
    }
    const definition = body.steps ? parse(body, 'request') : await this.#load(body.name);

    // Validate everything up front, so a typo fails now rather than at minute 7.
    const steps = definition.steps
      .map((s, index) => {
        let atMs;
        try {
          atMs = parseDuration(s.at);
        } catch (err) {
          throw new HttpError(400, `Step ${index + 1}: ${err.message}`);
        }
        return { index: index + 1, atMs, service: s.service, action: s.reset ? 'reset' : s.profile, status: 'pending' };
      })
      .sort((a, b) => a.atMs - b.atMs || a.index - b.index);
    for (const s of steps) if (s.action !== 'reset') this.virtualizer.getProfile(s.action);
    for (const service of new Set(steps.map((s) => s.service))) {
      if (!(await this.virtualizer.wiremock.findMappingsByService(service)).length) {
        throw new HttpError(404, `No stubs found for service "${service}"`);
      }
    }

    const run = { name: definition.name, startedAt: Date.now(), steps, state: 'running' };
    this.active = run;
    // Steps due now are applied before responding, so the caller knows the starting state.
    for (const step of steps.filter((s) => s.atMs === 0)) await this.#fire(run, step);
    for (const step of steps.filter((s) => s.atMs > 0)) {
      step.timer = setTimeout(() => this.#fire(run, step), step.atMs);
    }
    this.#finishIfDone(run);
    return this.current();
  }

  async cancel({ reset = false } = {}) {
    const run = this.active;
    if (!run) throw new HttpError(409, 'No timeline has been started');
    const wasRunning = run.state === 'running';
    for (const step of run.steps) {
      clearTimeout(step.timer);
      if (step.status === 'pending') step.status = 'cancelled';
    }
    if (wasRunning) run.state = 'cancelled';
    const resetServices = [];
    if (reset) {
      for (const service of new Set(run.steps.map((s) => s.service))) {
        await this.virtualizer.resetService(service, { reason: `timeline ${run.name} cancelled` });
        resetServices.push(service);
      }
    }
    return { ...this.current(), resetServices };
  }

  async #fire(run, step) {
    if (run.state !== 'running' || step.status !== 'pending') return;
    const reason = `timeline ${run.name} step ${step.index}`;
    try {
      if (step.action === 'reset') await this.virtualizer.resetService(step.service, { reason });
      else await this.virtualizer.applyProfile(step.service, step.action, { reason });
      step.status = 'applied';
    } catch (err) {
      step.status = 'failed';
      step.error = err.message;
    }
    step.firedAt = new Date().toISOString();
    this.#finishIfDone(run);
  }

  #finishIfDone(run) {
    if (run.state === 'running' && run.steps.every((s) => s.status !== 'pending')) {
      run.state = run.steps.some((s) => s.status === 'failed') ? 'finished-with-errors' : 'finished';
    }
  }

  async #load(name) {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new HttpError(400, 'Body must be {"name": "<timeline file>"} or {"steps": [...]}');
    }
    for (const ext of ['yaml', 'yml']) {
      const file = path.join(this.timelinesDir, `${name}.${ext}`);
      const text = await fs.readFile(file, 'utf8').catch(() => null);
      if (text !== null) return parse(YAML.parse(text), `${name}.${ext}`);
    }
    throw new HttpError(404, `No timeline file "${name}" in ${this.timelinesDir}`);
  }
}

function parse(raw, source) {
  const result = timelineSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new HttpError(400, `Invalid timeline (${source}): ${detail}`);
  }
  return result.data;
}
