// Thin client for the WireMock admin API. Everything WireMock-specific lives here,
// so the engine could be swapped later without touching the control API.
export class WireMockError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'WireMockError';
    this.status = status;
  }
}

export class WireMockClient {
  constructor(baseUrl, { timeoutMs = 10000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.admin = `${this.baseUrl}/__admin`;
    this.timeoutMs = timeoutMs;
  }

  async #request(method, pathname, body) {
    let res;
    try {
      res = await fetch(this.admin + pathname, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (err) {
      throw new WireMockError(`WireMock unreachable at ${this.baseUrl}: ${err.message}`, 502);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new WireMockError(`WireMock ${method} ${pathname} failed (${res.status}): ${text.slice(0, 300)}`, 502);
    }
    return text ? JSON.parse(text) : null;
  }

  async isUp() {
    try {
      await this.#request('GET', '/health');
      return true;
    } catch {
      return false;
    }
  }

  async waitUntilUp({ attempts = 30, delayMs = 1000 } = {}) {
    for (let i = 0; i < attempts; i++) {
      if (await this.isUp()) return;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new WireMockError(`WireMock did not become healthy at ${this.baseUrl}`, 502);
  }

  // Info from the service-virtualizer WireMock extension, or null if it isn't loaded.
  async extensionInfo() {
    try {
      return await this.#request('GET', '/sv/info');
    } catch {
      return null;
    }
  }

  async listMappings() {
    return (await this.#request('GET', '/mappings')).mappings ?? [];
  }

  async findMappingsByService(service) {
    const result = await this.#request('POST', '/mappings/find-by-metadata', {
      matchesJsonPath: { expression: '$.service', equalTo: service }
    });
    return result.mappings ?? [];
  }

  updateMapping(mapping) {
    return this.#request('PUT', `/mappings/${mapping.id}`, mapping);
  }

  importMappings(mappings) {
    return this.#request('POST', '/mappings/import', {
      mappings,
      importOptions: { duplicatePolicy: 'OVERWRITE', deleteAllNotInImport: false }
    });
  }

  async serveEvents(limit, since) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (since) query.set('since', since);
    return (await this.#request('GET', `/requests?${query}`)).requests ?? [];
  }

  startRecording(spec) {
    return this.#request('POST', '/recordings/start', spec);
  }

  async stopRecording() {
    return (await this.#request('POST', '/recordings/stop')).mappings ?? [];
  }

  async recordingStatus() {
    return (await this.#request('GET', '/recordings/status')).status;
  }

  async unmatchedRequests() {
    return (await this.#request('GET', '/requests/unmatched')).requests ?? [];
  }

  resetJournal() {
    return this.#request('DELETE', '/requests');
  }
}
