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

  applyProfile(service, profileName) {
    const profile = this.getProfile(profileName);
    return this.#withLock(service, async () => {
      const mappings = await this.#mappingsFor(service);
      const appliedAt = new Date().toISOString();
      for (const m of mappings) {
        const baseline = m.metadata?.sv?.baseline ?? m.response;
        await this.wiremock.updateMapping({
          ...m,
          response: toWireMockResponse(baseline, profile),
          metadata: { ...m.metadata, sv: { baseline, profile: profile.name, appliedAt } }
        });
      }
      return {
        service,
        profile: profile.name,
        stubsUpdated: mappings.length,
        appliedAt,
        expected: describeProfile(profile).expectedMs
      };
    });
  }

  resetService(service) {
    return this.#withLock(service, async () => {
      const mappings = await this.#mappingsFor(service);
      let restored = 0;
      for (const m of mappings) {
        if (!m.metadata?.sv) continue;
        const { sv, ...rest } = m.metadata;
        await this.wiremock.updateMapping({ ...m, response: sv.baseline, metadata: rest });
        restored += 1;
      }
      return { service, profile: 'baseline', stubsRestored: restored };
    });
  }

  // Latency WireMock actually served, from its request journal.
  async serviceStats(service, limit = 1000) {
    const events = await this.wiremock.serveEvents(limit);
    const mine = events.filter((e) => e.stubMapping?.metadata?.service === service);
    const totals = mine.map((e) => e.timing?.totalTime).filter((t) => typeof t === 'number');
    const statuses = {};
    for (const e of mine) {
      const key = e.response?.fault ?? String(e.response?.status ?? 'unknown');
      statuses[key] = (statuses[key] ?? 0) + 1;
    }
    return {
      service,
      sampled: mine.length,
      journalWindow: events.length,
      latencyMs: summarize(totals),
      statuses
    };
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
    expectedMs: expectedPercentiles(profile.latency)
  };
}
