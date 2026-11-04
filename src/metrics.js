// Exports per-service metrics to InfluxDB 1.x (line protocol), the same database
// perf-framework's JMeter Backend Listener writes to, tagged with the current runId.
//
// Every interval it drains the extension's counters (which see every request, not just
// the journal), adds capacity-pool state, and writes one point per service to the
// "virtual_service" measurement. Profile changes go to "virtual_service_events" so
// Grafana can show them as annotations. Export problems are logged, never thrown:
// metrics must not break the virtual service.

export class MetricsExporter {
  constructor({ wiremock, writeUrl, intervalMs = 5000, profileOf = () => 'baseline', log = console }) {
    this.wiremock = wiremock;
    this.writeUrl = writeUrl;
    this.intervalMs = intervalMs;
    this.profileOf = profileOf;
    this.log = log;
    this.runId = null;
    this.latest = null;
    this.timer = null;
    this.lastWarning = 0;
    this.pending = [];
  }

  get enabled() {
    return Boolean(this.writeUrl);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  setRun(runId) {
    this.runId = runId ?? null;
  }

  // Drain one interval from WireMock and write it. Also usable on demand (and in tests).
  async flush() {
    const [drained, info] = await Promise.all([this.wiremock.drainMetrics(), this.wiremock.extensionInfo()]);
    if (!drained) return null;
    const pools = info?.pools ?? {};
    const seconds = Math.max((drained.intervalEnd - drained.intervalStart) / 1000, 0.001);
    const timestampNs = BigInt(drained.intervalEnd) * 1_000_000n;

    const services = {};
    const lines = [];
    for (const [service, m] of Object.entries(drained.services)) {
      const pool = pools[service];
      const point = {
        ...m,
        rps: round(m.count / seconds, 3),
        errors: m.status5xx + m.faults,
        errorRate: m.count ? round((m.status5xx + m.faults) / m.count, 4) : 0,
        ...(pool && { busy: pool.busy, waiting: pool.waiting, maxConcurrent: pool.maxConcurrent })
      };
      services[service] = point;
      lines.push(
        line(
          'virtual_service',
          { service, profile: this.profileOf(service), runId: this.runId ?? 'none' },
          point,
          timestampNs
        )
      );
    }
    this.latest = {
      intervalStart: drained.intervalStart,
      intervalEnd: drained.intervalEnd,
      runId: this.runId,
      services
    };
    await this.#write([...this.pending.splice(0), ...lines]);
    return this.latest;
  }

  // A profile change or timeline step, shown as a Grafana annotation.
  event({ service, title, profile, kind = 'profile' }) {
    const ts = BigInt(Date.now()) * 1_000_000n;
    this.pending.push(
      line(
        'virtual_service_events',
        { service, kind, runId: this.runId ?? 'none' },
        { title, profile: profile ?? '' },
        ts
      )
    );
  }

  async #write(lines) {
    if (!this.enabled || lines.length === 0) return;
    try {
      const res = await fetch(this.writeUrl, {
        method: 'POST',
        body: lines.join('\n'),
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) throw new Error(`InfluxDB write failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    } catch (err) {
      // Log at most once a minute so an InfluxDB outage doesn't flood the logs.
      if (Date.now() - this.lastWarning > 60000) {
        this.lastWarning = Date.now();
        this.log.warn?.(`Metrics export to ${this.writeUrl} failed: ${err.message}`);
      }
    }
  }
}

// InfluxDB line protocol: measurement,tag=v field=v,int=1i timestamp
export function line(measurement, tags, fields, timestampNs) {
  const tagPart = Object.entries(tags)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${escapeKey(k)}=${escapeKey(String(v))}`)
    .join(',');
  const fieldPart = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${escapeKey(k)}=${fieldValue(k, v)}`)
    .join(',');
  return `${escapeMeasurement(measurement)}${tagPart ? `,${tagPart}` : ''} ${fieldPart} ${timestampNs}`;
}

// Counts are integers; latencies and rates are floats, so a field never changes type.
const INTEGER_FIELDS = new Set([
  'count',
  'status2xx',
  'status3xx',
  'status4xx',
  'status5xx',
  'faults',
  'injected',
  'rejected',
  'errors',
  'busy',
  'waiting',
  'maxConcurrent'
]);

function fieldValue(key, v) {
  if (typeof v === 'string') return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return INTEGER_FIELDS.has(key) ? `${Math.round(v)}i` : String(Number(v));
}

function escapeKey(s) {
  return s.replace(/[,= ]/g, (c) => `\\${c}`);
}

function escapeMeasurement(s) {
  return s.replace(/[, ]/g, (c) => `\\${c}`);
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
