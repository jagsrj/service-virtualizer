// Record mode: WireMock proxies to the real dependency and captures stubs, while we
// collect the real response times from its journal and fit a latency profile to them.
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { fitProfile } from './fit.js';
import { HttpError } from './virtualizer.js';

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const JOURNAL_LIMIT = 100000;

export function assertName(value, what) {
  if (typeof value !== 'string' || !NAME.test(value)) {
    throw new HttpError(400, `${what} must use lowercase letters, digits and dashes`);
  }
}

export class Recorder {
  constructor({ virtualizer, save = true }) {
    this.virtualizer = virtualizer;
    this.wiremock = virtualizer.wiremock;
    this.save = save;
    this.active = null;
  }

  status() {
    return this.active ? { recording: true, ...this.active } : { recording: false };
  }

  async start({ service, targetUrl, urlPathPattern }) {
    assertName(service, 'service');
    let target;
    try {
      target = new URL(targetUrl);
    } catch {
      throw new HttpError(400, 'targetUrl must be an absolute http(s) URL');
    }
    if (!['http:', 'https:'].includes(target.protocol)) throw new HttpError(400, 'targetUrl must be http or https');
    if (this.active) throw new HttpError(409, `Already recording "${this.active.service}"; stop it first`);
    if ((await this.wiremock.recordingStatus()) === 'Recording') {
      throw new HttpError(409, 'WireMock is already recording (started outside this tool)');
    }

    const warnings = [];
    const existing = await this.wiremock.findMappingsByService(service);
    if (existing.length) {
      warnings.push(
        `Service "${service}" already has ${existing.length} stubs. Requests they match are answered by the stubs, ` +
          'not proxied, so they will not be recorded. Use a new service name or remove those stubs to re-record them.'
      );
    }

    const targetBaseUrl = target.href.replace(/\/+$/, '');
    // Journal timestamps have millisecond precision; step back slightly so no sample is missed.
    const startedAt = new Date(Date.now() - 1000).toISOString();
    await this.wiremock.startRecording({
      targetBaseUrl,
      ...(urlPathPattern && { filters: { urlPathPattern } }),
      requestBodyPattern: { matcher: 'equalToJson', ignoreArrayOrder: true, ignoreExtraElements: true },
      persist: false,
      repeatsAsScenarios: false
    });
    this.active = { service, targetUrl: targetBaseUrl, startedAt };
    return { ...this.status(), warnings };
  }

  async stop({ save = this.save, fit = true } = {}) {
    if (!this.active) throw new HttpError(409, 'No recording in progress');
    const { service, targetUrl, startedAt } = this.active;

    // Read the latencies before stopping, while the proxy mapping still identifies proxied traffic.
    const events = await this.wiremock.serveEvents(JOURNAL_LIMIT, startedAt);
    const proxied = events.filter((e) => stripSlash(e.stubMapping?.response?.proxyBaseUrl) === targetUrl);
    const samples = proxied.map((e) => e.timing?.serveTime).filter((t) => typeof t === 'number');

    const recorded = await this.wiremock.stopRecording();
    this.active = null;

    const recordedAt = new Date().toISOString();
    const mappings = recorded.map((m) => ({
      ...m,
      name: m.name ?? `${m.request?.method ?? 'ANY'} ${m.request?.url ?? m.request?.urlPath ?? ''}`.trim(),
      metadata: { ...m.metadata, service, source: 'recorded', recordedFrom: targetUrl, recordedAt }
    }));
    if (mappings.length) await this.wiremock.importMappings(mappings);

    const result = { service, targetUrl, stubsRecorded: mappings.length, samples: samples.length, warnings: [] };
    if (events.length >= JOURNAL_LIMIT) {
      result.warnings.push('Journal limit reached; some latency samples may be missing.');
    }

    if (save && mappings.length) {
      const file = path.join(this.virtualizer.stubsDir, service, `recorded-${stamp(recordedAt)}.json`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const toSave = mappings.map((m) => ({ ...m, metadata: { ...m.metadata, source: undefined } }));
      await fs.writeFile(file, JSON.stringify({ mappings: toSave }, null, 2) + '\n');
      result.stubsFile = path.relative(path.dirname(this.virtualizer.stubsDir), file);
    }

    if (fit && samples.length) {
      const fitted = fitProfile(`${service}-recorded`, samples, {
        description: `Fitted from ${samples.length} requests recorded from ${targetUrl} on ${recordedAt.slice(0, 10)}`
      });
      result.fit = fitted;
      if (save) result.profileFile = await this.saveProfile(fitted.profile, { overwrite: true });
    } else if (fit) {
      result.warnings.push('No proxied requests were captured, so no profile was fitted.');
    }
    return result;
  }

  // Fit from latencies gathered elsewhere (JMeter JTL, Dynatrace, Splunk).
  async fitFromSamples({ name, samplesMs, description, save = false, overwrite = false }) {
    assertName(name, 'name');
    if (!Array.isArray(samplesMs) || samplesMs.length === 0)
      throw new HttpError(400, 'samplesMs must be a non-empty array');
    if (samplesMs.length > 1_000_000) throw new HttpError(400, 'samplesMs is limited to 1,000,000 values');
    let fitted;
    try {
      fitted = fitProfile(name, samplesMs, { description });
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    if (save) fitted.profileFile = await this.saveProfile(fitted.profile, { overwrite });
    return fitted;
  }

  // Recordings always refresh their own <service>-recorded profile; anything else
  // refuses to replace an existing profile unless overwrite is requested.
  async saveProfile(profile, { overwrite = false } = {}) {
    const dir = this.virtualizer.profilesDir;
    const file = path.join(dir, `${profile.name}.yaml`);
    const fileExists = await fs.access(file).then(
      () => true,
      () => false
    );
    const nameTaken = this.virtualizer.profiles.has(profile.name);
    if (nameTaken && !fileExists) {
      throw new HttpError(409, `Profile "${profile.name}" is defined in another file; choose a different name`);
    }
    if ((nameTaken || fileExists) && !overwrite) {
      throw new HttpError(409, `Profile "${profile.name}" already exists; pass "overwrite": true to replace it`);
    }
    await fs.writeFile(file, YAML.stringify(profile));
    await this.virtualizer.reloadProfiles();
    return path.relative(path.dirname(dir), file);
  }
}

function stripSlash(url) {
  return typeof url === 'string' ? url.replace(/\/+$/, '') : url;
}

function stamp(iso) {
  return iso.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}
