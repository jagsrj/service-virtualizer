// Core logic: virtual services are groups of WireMock stubs tagged with metadata.service.
// A profile is applied by rewriting each stub's response from its saved baseline.
import fs from 'node:fs/promises';
import path from 'node:path';
import { expectedPercentiles, loadProfiles, toWireMockResponse } from './profiles.js';
import { summarize } from './stats.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class Virtualizer {
  constructor({ wiremock, profilesDir, stubsDir }) {
    this.wiremock = wiremock;
    this.profilesDir = profilesDir;
    this.stubsDir = stubsDir;
    this.profiles = new Map();
    this.locks = new Map();
    this.activeProfiles = new Map(); // service -> profile name, for metric tags
    this.listeners = [];
  }

  // Called with { service, profile, reason } after every profile change.
  onChange(listener) {
    this.listeners.push(listener);
  }

  profileOf(service) {
    return this.activeProfiles.get(service) ?? 'baseline';
  }

  // Pick up profiles already applied in WireMock (e.g. after this service restarts).
  async syncActiveProfiles() {
    for (const s of await this.listServices()) this.activeProfiles.set(s.name, s.profile);
  }

  #changed(service, profile, reason) {
    this.activeProfiles.set(service, profile);
    for (const listener of this.listeners) {
      try {
        listener({ service, profile, reason });
      } catch (err) {
        console.warn(`Profile change listener failed: ${err.message}`);
      }
    }
  }

  async reloadProfiles() {
    this.profiles = await loadProfiles(this.profilesDir);
    return this.listProfiles();
  }

  listProfiles() {
    return [...this.profiles.values()].map(describeProfile);
  }

  getProfile(name) {
    const profile = this.profiles.get(name);
    if (!profile) throw new HttpError(404, `Unknown profile "${name}". Known: ${[...this.profiles.keys()].join(', ')}`);
    return profile;
  }

  async listServices() {
    const mappings = await this.wiremock.listMappings();
    const services = new Map();
    for (const m of mappings) {
      const name = m.metadata?.service;
      if (!name) continue;
      const entry = services.get(name) ?? { name, stubs: 0, profiles: new Set() };
      entry.stubs += 1;
      entry.profiles.add(m.metadata?.sv?.profile ?? 'baseline');
      services.set(name, entry);
    }
    return [...services.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, stubs, profiles }) => ({
        name,
        stubs,
        profile: profiles.size === 1 ? [...profiles][0] : 'mixed'
      }));
  }

  applyProfile(service, profileName, { reason = 'api' } = {}) {
    const profile = this.getProfile(profileName);
    return this.#withLock(service, async () => {
      if ((profile.errors || profile.concurrency) && !(await this.wiremock.extensionInfo())) {
        const what = profile.errors ? 'injects errors' : 'limits concurrency';
        throw new HttpError(
          409,
          `Profile "${profile.name}" ${what}, which needs the service-virtualizer WireMock extension. ` +
            'Run WireMock with extension/target/sv-wiremock-extension.jar on its classpath (see README).'
        );
      }
      const mappings = await this.#mappingsFor(service);
      const appliedAt = new Date().toISOString();
      for (const m of mappings) {
        const baseline = m.metadata?.sv?.baseline ?? m.response;
        await this.wiremock.updateMapping({
          ...m,
          response: toWireMockResponse(baseline, profile, { service }),
          metadata: { ...m.metadata, sv: { baseline, profile: profile.name, appliedAt } }
        });
      }
      // Every profile switch starts with an empty queue.
      await this.wiremock.resetPool(service);
      this.#changed(service, profile.name, reason);
      return {
        service,
        profile: profile.name,
        stubsUpdated: mappings.length,
        appliedAt,
        expected: describeProfile(profile).expectedMs
      };
    });
  }

  resetService(service, { reason = 'api' } = {}) {
    return this.#withLock(service, async () => {
      const mappings = await this.#mappingsFor(service);
      let restored = 0;
      for (const m of mappings) {
        if (!m.metadata?.sv) continue;
        const { sv, ...rest } = m.metadata;
        await this.wiremock.updateMapping({ ...m, response: sv.baseline, metadata: rest });
        restored += 1;
      }
      await this.wiremock.resetPool(service);
      this.#changed(service, 'baseline', reason);
      return { service, profile: 'baseline', stubsRestored: restored };
    });
  }

  // Latency WireMock actually served, from its request journal.
  async serviceStats(service, limit = 1000) {
    const events = await this.wiremock.serveEvents(limit);
    const mine = events.filter((e) => e.stubMapping?.metadata?.service === service);
    const totals = mine.map((e) => e.timing?.totalTime).filter((t) => typeof t === 'number');
    const statuses = {};
    let errors = 0;
    let injected = 0;
    let rejected = 0;
    const queueWaits = [];
    for (const e of mine) {
      const fault = e.responseDefinition?.fault ?? e.response?.fault;
      const status = e.response?.status;
      const key = fault ?? String(status ?? 'unknown');
      statuses[key] = (statuses[key] ?? 0) + 1;
      if (fault || status >= 500) errors += 1;
      const headers = Object.fromEntries(
        Object.entries(e.response?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
      );
      const isRejected = 'x-sv-rejected' in headers;
      if (isRejected) rejected += 1;
      else if (fault || 'x-sv-injected' in headers) injected += 1;
      const wait = Number(headers['x-sv-queue-wait-ms']);
      if (!isRejected && Number.isFinite(wait)) queueWaits.push(wait);
    }
    const rate = (n) => (mine.length ? Math.round((n / mine.length) * 10000) / 10000 : 0);
    return {
      service,
      sampled: mine.length,
      journalWindow: events.length,
      latencyMs: summarize(totals),
      statuses,
      errorRate: rate(errors),
      injectedRate: rate(injected),
      rejectedRate: rate(rejected),
      ...(queueWaits.length && { queueWaitMs: summarize(queueWaits) })
    };
  }

  // Live state of the service's capacity pool (busy workers, queue length, totals).
  async capacity(service) {
    const info = await this.wiremock.extensionInfo();
    if (!info) throw new HttpError(409, 'The service-virtualizer WireMock extension is not loaded');
    const pool = info.pools?.[service];
    if (!pool) return { service, limited: false };
    return { service, limited: true, ...pool };
  }

  async unmatched() {
    const requests = await this.wiremock.unmatchedRequests();
    return requests.map((r) => ({ method: r.method, url: r.url, loggedDate: r.loggedDateString }));
  }

  // Loads stubs/<service>/*.json. Each file holds one mapping or { "mappings": [...] }.
  // metadata.service defaults to the folder name, so stub authors rarely need to set it.
  async loadStubs() {
    const entries = await fs.readdir(this.stubsDir, { withFileTypes: true });
    const mappings = [];
    for (const dir of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const serviceDir = path.join(this.stubsDir, dir.name);
      const files = (await fs.readdir(serviceDir)).filter((f) => f.endsWith('.json')).sort();
      for (const file of files) {
        let parsed;
        try {
          parsed = JSON.parse(await fs.readFile(path.join(serviceDir, file), 'utf8'));
        } catch (err) {
          throw new Error(`Invalid JSON in stubs/${dir.name}/${file}: ${err.message}`);
        }
        for (const m of Array.isArray(parsed.mappings) ? parsed.mappings : [parsed]) {
          mappings.push({ ...m, metadata: { service: dir.name, ...m.metadata, source: `${dir.name}/${file}` } });
        }
      }
    }
    if (mappings.length) await this.wiremock.importMappings(mappings);
    const services = [...new Set(mappings.map((m) => m.metadata.service))];
    return { stubsLoaded: mappings.length, services };
  }

  async #mappingsFor(service) {
    const mappings = await this.wiremock.findMappingsByService(service);
    if (!mappings.length) throw new HttpError(404, `No stubs found for service "${service}"`);
    return mappings;
  }

  // Serialize changes per service so two profile switches cannot interleave.
  #withLock(key, fn) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(key, next);
    next
      .finally(() => {
        if (this.locks.get(key) === next) this.locks.delete(key);
      })
      .catch(() => {});
    return next;
  }
}

export function describeProfile(profile) {
  return {
    name: profile.name,
    description: profile.description ?? '',
    latency: profile.latency,
    ...(profile.status !== undefined && { status: profile.status }),
    ...(profile.fault && { fault: profile.fault }),
    ...(profile.dribble && { dribble: profile.dribble }),
    ...(profile.errors && { errors: profile.errors }),
    ...(profile.concurrency && { concurrency: profile.concurrency }),
    expectedMs: expectedPercentiles(profile.latency)
  };
}
