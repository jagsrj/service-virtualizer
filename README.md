# service-virtualizer

Performance-focused service virtualization. [WireMock](https://wiremock.org) serves the virtual endpoints. A small Node.js control service sits beside it and adds what performance testing needs: **latency and fault profiles** you can switch on a whole dependency with one API call, in the middle of a test.

It is part of a performance toolset with [perf-framework](https://github.com/jagsrj/perf-framework), [perf-insight](https://github.com/jagsrj/perf-insight) and [chaos-runner](https://github.com/jagsrj/chaos-runner).

```
 App under test ──► WireMock :8080  (matching, templating, delays, faults)
                        ▲
                        │ admin API
 perf-framework ──► control API :4100  (profiles, services, stats)
 chaos-runner   ──►      │
 CI / curl      ──►      ├── profiles/*.yaml   latency + fault profiles
                         └── stubs/<service>/*.json   WireMock stub mappings
```

## Why profiles

A stub that always answers in 5ms makes your test lie: the app looks faster than it will be in production, and slow-dependency problems (thread-pool exhaustion, missing timeouts, retry storms) never show up. Profiles describe dependency behaviour the way a performance engineer measures it, by percentiles:

```yaml
name: degraded
latency:
  type: lognormal
  p50Ms: 600
  p95Ms: 2500 # sigma is derived for you
  capMs: 8000 # hard upper bound
```

The control API converts that into a WireMock lognormal delay distribution and tells you the percentiles to expect.

## Quick start

```bash
cd infra && docker compose up -d --build
curl localhost:4100/api/services
curl -X POST localhost:4100/api/services/doc-verify/profile -H 'content-type: application/json' -d '{"profile":"degraded"}'
curl -X POST localhost:8080/v1/documents/verify -H 'content-type: application/json' -d '{"documentType":"PASSPORT"}'
curl localhost:4100/api/services/doc-verify/stats
curl -X POST localhost:4100/api/services/doc-verify/reset
```

Without Docker: run WireMock yourself (`java -jar wiremock-standalone.jar --port 8080 --async-response-enabled true`), then `npm install && npm start`.

## Error injection

Real dependencies rarely fail completely. More often a small share of requests fails while the rest look fine. Add an `errors` section to any profile:

```yaml
name: flaky
latency: { type: lognormal, p50Ms: 80, p95Ms: 160, capMs: 1000 }
errors:
  rate: 0.02 # 2% of requests fail
  responses: # which failure, chosen by weight
    - status: 500
      body: '{"error":"internal_error"}'
      weight: 3
    - status: 503
      latencyMs: 10 # errors can have their own timing (fast 503s...)
      weight: 1
    - fault: CONNECTION_RESET_BY_PEER
      weight: 1
```

Bundled: `flaky` (2% errors, healthy latency) and `brownout` (slow, plus 10% errors including 10-second gateway timeouts).

WireMock can't do percentage-based errors on its own, so this runs in a small WireMock extension (`extension/`). The same extension also handles capacity limits (below). For each request, it picks error or normal using the profile's rate. Injected status errors carry an `X-SV-Injected: true` header, so you can tell them apart from real errors in JMeter results. `GET /api/services/:service/stats` reports the observed `errorRate`.

The Compose stack builds WireMock with the extension included. To run it yourself:

```bash
cd extension
mvn package                                            # or: WIREMOCK_JAR=/path/to/wiremock.jar ./build.sh
java -cp wiremock-standalone-3.13.2.jar:target/sv-wiremock-extension.jar wiremock.Run --port 8080 --async-response-enabled true
```

The extension registers itself through Java's service loader, so no `--extensions` flag is needed. `GET /api/health` shows whether it's loaded. Applying an error profile without the extension is refused with a clear message rather than silently doing nothing.

## Capacity limits

A stub with unlimited capacity hides the most common real-world failure: the dependency runs out of threads. Add `concurrency` to a profile and the virtual service behaves like a server with a fixed worker pool:

```yaml
name: capacity-limited
latency: { type: lognormal, p50Ms: 80, p95Ms: 160, capMs: 1000 }
concurrency:
  maxConcurrent: 20 # workers (e.g. the real service's thread pool)
  maxQueue: 200 # optional: waiting requests beyond this are rejected immediately
  queueTimeoutMs: 5000 # optional: requests that would wait longer are rejected after this long
  reject: { status: 503, body: '{"error":"server_busy"}' }
```

Up to `maxConcurrent` requests are served at the profile's latency. Requests after that wait in a FIFO queue, so their latency becomes queue wait plus service time. Throughput levels off at `maxConcurrent / service time`, and latency climbs instead, just as Little's law predicts. Measured with 5 workers at 100ms (capacity 50 requests/s):

| Concurrent users | Throughput | p50 latency |
| ---------------- | ---------- | ----------- |
| 2                | 19 req/s   | 106 ms      |
| 5                | 48 req/s   | 104 ms      |
| 25               | ~50 req/s  | 498 ms      |

How it works: the extension models the pool mathematically (a multi-server queue) rather than blocking threads. Each arriving request is assigned the earliest-free worker and given a delay of queue wait plus a sampled service time. WireMock then schedules that delay asynchronously. So the cap you set is the only limit; WireMock's own threads aren't. The pool is shared by every stub in the service, like one real service's thread pool. Each profile switch or reset starts from an empty queue.

Response headers for analysis in JMeter: `X-SV-Queue-Wait-Ms` on every response, and `X-SV-Rejected: true` on capacity rejections (kept separate from `X-SV-Injected` errors). `GET /api/services/:service/capacity` shows busy workers, queue length and totals live. The stats endpoint reports `rejectedRate` and the queue-wait percentiles.

Capacity and error injection combine: an injected error still takes a worker, using its own `latencyMs` if it has one.

## Record mode

Point the virtual service at the real dependency, run your traffic through it, and stop. You get stubs **and** a latency profile fitted to how the real dependency actually behaved.

```bash
curl -X POST localhost:4100/api/recordings/start -H 'content-type: application/json' \
  -d '{"service":"core-banking","targetUrl":"https://core-banking.test.internal"}'
# point the app (or a JMeter smoke test) at localhost:8080 and exercise the flows
curl -X POST localhost:4100/api/recordings/stop -H 'content-type: application/json' -d '{}'
```

The stop response shows what was captured and how good the fit is:

```json
{
  "service": "core-banking",
  "stubsRecorded": 4,
  "samples": 400,
  "stubsFile": "stubs/core-banking/recorded-20261104-161502.json",
  "profileFile": "profiles/core-banking-recorded.yaml",
  "fit": {
    "observedMs": { "p50": 107, "p90": 178, "p95": 207, "p99": 238, "max": 358 },
    "fittedMs": { "p50": 107, "p90": 179, "p95": 207, "p99": 272 },
    "fitErrorPct": { "p90": 0.6, "p99": 14.3 },
    "warnings": []
  }
}
```

Then replay it with the real dependency switched off: `POST /api/services/core-banking/profile {"profile":"core-banking-recorded"}`.

How it works:

- WireMock proxies to `targetUrl` and records one stub per unique request (JSON bodies matched with `equalToJson`, ignoring extra fields and array order).
- The real response time of every proxied request is read from WireMock's journal.
- The fit uses **quantile matching**: median = observed p50, and sigma comes from observed p95. The p50 and p95 the fit reproduces are the ones you report on. The cap is the largest latency observed.
- Recorded stubs and the fitted profile are written to `stubs/` and `profiles/`, so you can review them and commit them to git.
- Warnings flag small samples (under 20) and tails that aren't lognormal-shaped. A common case is a bimodal cache hit/miss pattern, where the fitted p99 would mislead.

Things to know:

- Requests that already match an existing stub are answered by that stub, not recorded. Record into a new service name.
- Recorded latency includes the proxy hop, and replay adds WireMock's own processing time (a few ms on real hardware; ~10–15ms in a constrained container). This only matters for dependencies that respond in under ~20ms.
- One recording at a time (a WireMock limitation).

### Fit from other sources

Already have latencies from a JMeter JTL, Dynatrace or Splunk? Fit them directly:

```bash
curl -X POST localhost:4100/api/profiles/fit -H 'content-type: application/json' \
  -d '{"name":"doc-verify-prod","samplesMs":[112, 98, 143, ...],"save":true}'
```

Saving never replaces an existing profile unless you pass `"overwrite": true`.

## Metrics, runs and timelines

### Metrics in Grafana

The WireMock extension counts every request it serves, per virtual service. It doesn't use the request journal, which is capped and best turned off for long tests. Every 5 seconds the control API writes one point per service to InfluxDB 1.x: the same database perf-framework's JMeter listener uses, tagged with the same `runId`.

- `virtual_service` (tags `service`, `profile`, `runId`): `rps`, `count`, `status2xx`…`status5xx`, `faults`, `errors`, `errorRate`, `injected`, `rejected`, `latencyMean`/`P50`/`P90`/`P95`/`P99`/`Max`, `queueWaitMean`/`Max`, and for capacity-limited services `busy`, `waiting`, `maxConcurrent`.
- `virtual_service_events`: one point per profile change, shown as annotations on the dashboard.

Import `grafana/service-virtualizer-dashboard.json` into perf-framework's Grafana (it uses the `influxdb` datasource). It has throughput, latency percentiles, error rate, injected vs rejected, capacity pool, queue wait and unmatched requests, with `runId` and `service` filters. `service="unmatched"` counts requests no stub answered. Anything above zero means the test is hitting endpoints that aren't virtualised.

The `profile` tag is the profile active at the end of each interval. Annotations mark the exact switch time.

Without InfluxDB, `GET /api/metrics/latest` returns the most recent interval.

### Runs

```bash
curl -X POST localhost:4100/api/runs -H 'content-type: application/json' -d '{"runId":"20261104-0930-checkout","scenario":"Checkout Load"}'
# ... test runs ...
curl -X DELETE localhost:4100/api/runs/20261104-0930-checkout
```

Starting a run tags all metrics with its `runId`. If `timelines/<scenario-name>.yaml` exists (the name lowercased with dashes, e.g. `checkout-load.yaml`), that timeline starts automatically. Ending the run flushes the final interval, cancels the run's timeline and resets the services it touched. Ending an old run that isn't the current one is ignored. A timeline that can't start, for example one naming an unknown profile, doesn't block the run; the response carries a `warning` instead.

perf-framework does this for you when `SERVICE_VIRTUALIZER_URL` is set (see perf-framework's docs).

### Timelines

Profile changes on a schedule, for degradation tests and chaos experiments:

```yaml
# timelines/doc-verify-brownout.yaml
name: doc-verify-brownout
steps:
  - { at: 0s, service: doc-verify, profile: healthy }
  - { at: 5m, service: doc-verify, profile: brownout }
  - { at: 7m, service: doc-verify, profile: healthy }
  - { at: 10m, service: doc-verify, reset: true }
```

- `POST /api/timelines {"name": "doc-verify-brownout"}` runs a file. `POST /api/timelines {"steps": [...]}` runs inline steps, which suits chaos-runner experiments.
- Every step is validated before anything starts, so a typo in a profile name fails now rather than at minute 7. Steps at `0` are applied before the call returns.
- `GET /api/timelines/current` shows each step's status. `DELETE /api/timelines/current?reset=true` cancels and resets.
- One timeline at a time. Timers live in the control service, so restarting it cancels a running timeline.

### Running next to perf-framework

```bash
cd perf-framework/infra && docker compose up -d
cd service-virtualizer/infra && docker compose -f docker-compose.yml -f docker-compose.perf-framework.yml up -d --build
```

The override joins perf-framework's Docker network (`infra_jmeter-network`) and points the exporter at its InfluxDB.

## Concepts

- **Virtual service**: every stub in `stubs/<service>/` belongs to that service (stored as `metadata.service` in WireMock). Profiles are applied to a whole service at once.
- **Profile**: YAML in `profiles/`. It controls an error rate (see above), latency (`none`, `fixed`, `uniform`, `lognormal`), and optionally `status` + `body` (for example, a 503 outage), `dribble` (slow body), or a `fault` (`CONNECTION_RESET_BY_PEER`, `EMPTY_RESPONSE`, `MALFORMED_RESPONSE_CHUNK`, `RANDOM_DATA_THEN_CLOSE`).
- **Baseline**: the stub's original response. It is saved the first time a profile is applied. Every profile is built from the baseline, so switching profiles never stacks delays, and `reset` restores it exactly.

Bundled profiles: `healthy`, `degraded`, `slow-drip`, `outage-503`, `connection-reset`, `flaky`, `brownout`, `capacity-limited`.

## Control API

| Method | Path                                      | Purpose                                                     |
| ------ | ----------------------------------------- | ----------------------------------------------------------- |
| GET    | `/api/health`                             | Control API and WireMock status                             |
| GET    | `/api/profiles`                           | Profiles with their expected p50/p90/p95/p99                |
| GET    | `/api/profiles/:name`                     | One profile                                                 |
| POST   | `/api/profiles/reload`                    | Re-read `profiles/`                                         |
| GET    | `/api/services`                           | Virtual services, stub counts, active profile               |
| POST   | `/api/services/:service/profile`          | Apply a profile: `{"profile":"degraded"}`                   |
| POST   | `/api/services/:service/reset`            | Back to baseline                                            |
| GET    | `/api/services/:service/stats?limit=1000` | Latency WireMock actually served, from its journal          |
| GET    | `/api/unmatched`                          | Requests no stub matched (check these first when debugging) |
| POST   | `/api/stubs/reload`                       | Re-import `stubs/` into WireMock                            |

## Configuration

| Variable              | Default                 |
| --------------------- | ----------------------- |
| `PORT`                | `4100`                  |
| `WIREMOCK_URL`        | `http://localhost:8080` |
| `PROFILES_DIR`        | `./profiles`            |
| `STUBS_DIR`           | `./stubs`               |
| `LOAD_STUBS_ON_START` | `true`                  |

## Performance notes

- Run WireMock with `--async-response-enabled`. Otherwise every delayed response holds a Jetty thread, and a slow profile caps the virtual service's throughput instead of just adding latency.
- Bound the request journal (`--max-request-journal-entries`), or memory grows for the whole length of a long test.
- Warm up the JVM before measuring. In testing, a cold WireMock added about 70ms to p50. After warm-up, observed latency was within about 10ms of the profile (healthy: expected p50 80 / p95 160, observed 91 / 176).
- Benchmark the virtual service at more than your target TPS before trusting results. It must never be the bottleneck.

## Tests

```bash
npm test                                                 # unit tests
WIREMOCK_JAR=/path/to/wiremock-standalone.jar npm test   # plus end-to-end tests against a real WireMock
SV_EXTENSION_JAR=extension/target/sv-wiremock-extension.jar WIREMOCK_JAR=... npm test   # plus error-injection, capacity and metrics tests
```

The recording tests put a fake dependency with known latency (lognormal, median 100ms, sigma 0.4) behind WireMock. They check that the fit recovers it, that the recorded stubs answer once the dependency is shut down, and that replaying the fitted profile reproduces the latency.

## Roadmap

1. ✅ WireMock engine + control API + latency/fault profiles
2. ✅ Record mode: proxy to the real dependency, save stubs, and **fit a profile to the recorded latencies**
3. ✅ Error-rate profiles (for example, 2% of requests return 500), via a WireMock extension
4. ✅ Concurrency caps, so the virtual service saturates like the real one
5. ✅ Metrics to InfluxDB/Grafana; runs tagged with perf-framework's runId; timelines for mid-test profile changes (perf-framework and chaos-runner)
6. More protocols: SOAP, gRPC, then Kafka/MQ
