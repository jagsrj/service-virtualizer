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

## Concepts

- **Virtual service**: every stub in `stubs/<service>/` belongs to that service (stored as `metadata.service` in WireMock). Profiles are applied to a whole service at once.
- **Profile**: YAML in `profiles/`. It controls latency (`none`, `fixed`, `uniform`, `lognormal`), and optionally `status` + `body` (for example, a 503 outage), `dribble` (slow body), or a `fault` (`CONNECTION_RESET_BY_PEER`, `EMPTY_RESPONSE`, `MALFORMED_RESPONSE_CHUNK`, `RANDOM_DATA_THEN_CLOSE`).
- **Baseline**: the stub's original response. It is saved the first time a profile is applied. Every profile is built from the baseline, so switching profiles never stacks delays, and `reset` restores it exactly.

Bundled profiles: `healthy`, `degraded`, `slow-drip`, `outage-503`, `connection-reset`.

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
npm test                                          # unit tests
WIREMOCK_JAR=/path/to/wiremock-standalone.jar npm test   # plus end-to-end tests against a real WireMock
```

## Roadmap

1. ✅ WireMock engine + control API + latency/fault profiles
2. Record mode: proxy to the real dependency, save stubs, and **fit a profile to the recorded latencies**
3. Error-rate profiles (for example, 2% of requests return 500), via a WireMock extension
4. Concurrency caps, so the virtual service saturates like the real one
5. Metrics to InfluxDB/Grafana; hooks for perf-framework (start services before a run) and chaos-runner (switch profiles mid-test)
6. More protocols: SOAP, gRPC, then Kafka/MQ
