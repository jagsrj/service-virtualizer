// Test runs from perf-framework (or CI). A run tags all metrics with its runId and, if a
// timeline file is named after the run's scenario, plays that timeline for the run's
// duration and resets the services when the run ends.
import fs from 'node:fs/promises';
import path from 'node:path';

export function slug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export class RunTracker {
  constructor({ metrics, timelines }) {
    this.metrics = metrics;
    this.timelines = timelines;
    this.run = null;
  }

  current() {
    return this.run ? { ...this.run } : { runId: null };
  }

  async start({ runId, scenario, timeline }) {
    if (this.run) await this.end(this.run.runId).catch(() => {});
    this.metrics?.setRun(runId);
    this.run = { runId, scenario: scenario ?? null, startedAt: new Date().toISOString(), timeline: null };

    // An explicit timeline wins; otherwise look for one named after the scenario.
    const name = timeline ?? (scenario ? slug(scenario) : null);
    if (name && (timeline || (await this.#timelineExists(name)))) {
      const state = this.timelines.current();
      if (state.running) {
        this.run.warning = `Timeline "${state.name}" is already running, so "${name}" was not started`;
      } else {
        try {
          await this.timelines.start({ name });
          this.run.timeline = name;
        } catch (err) {
          // A broken timeline must not stop the load test from starting; report it instead.
          this.run.warning = `Timeline "${name}" could not start: ${err.message}`;
        }
      }
    }
    return this.current();
  }

  // Ends the run if it is the current one; a stale end from an older run is ignored.
  async end(runId) {
    if (!this.run || (runId && this.run.runId !== runId)) {
      return { ended: null, reason: runId ? `Run "${runId}" is not the current run` : 'No run in progress' };
    }
    const run = this.run;
    // Flush first, so the run's final interval is still tagged with it.
    await this.metrics?.flush().catch(() => null);
    let timeline = null;
    if (run.timeline && this.timelines.current().name === run.timeline) {
      timeline = this.timelines.current().running
        ? await this.timelines.cancel({ reset: true })
        : this.timelines.current();
    }
    this.metrics?.setRun(null);
    this.run = null;
    return { ended: run.runId, timeline };
  }

  async #timelineExists(name) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return false;
    for (const ext of ['yaml', 'yml']) {
      const found = await fs.access(path.join(this.timelines.timelinesDir, `${name}.${ext}`)).then(
        () => true,
        () => false
      );
      if (found) return true;
    }
    return false;
  }
}
