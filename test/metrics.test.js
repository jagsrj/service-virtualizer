import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MetricsExporter, line } from '../src/metrics.js';

test('line protocol escapes tags and types fields', () => {
  const l = line(
    'virtual_service',
    { service: 'doc verify', runId: 'a,b=c' },
    { count: 3, p95: 12.5, title: 'say "hi"' },
    1n
  );
  assert.equal(l, 'virtual_service,service=doc\\ verify,runId=a\\,b\\=c count=3i,p95=12.5,title="say \\"hi\\"" 1');
});

test('counts are integers even when 0, latencies stay floats', () => {
  const l = line('m', {}, { count: 0, latencyP50: 100, busy: 2 }, 5n);
  assert.equal(l, 'm count=0i,latencyP50=100,busy=2i 5');
});

function sink() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      bodies.push({ url: req.url, body: b });
      res.statusCode = 204;
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, bodies, port: server.address().port })));
}

const drained = {
  intervalStart: 1_000_000,
  intervalEnd: 1_005_000,
  services: {
    'doc-verify': {
      count: 500,
      status2xx: 480,
      status3xx: 0,
      status4xx: 0,
      status5xx: 15,
      faults: 5,
      injected: 10,
      rejected: 10,
      latencyMean: 95.5,
      latencyP50: 90,
      latencyP90: 140,
      latencyP95: 160,
      latencyP99: 210,
      latencyMax: 400,
      queueWaitMean: 3.2,
      queueWaitMax: 40
    }
  }
};

test('exporter writes one point per service with run and profile tags', async () => {
  const { server, bodies, port } = await sink();
  const exporter = new MetricsExporter({
    wiremock: {
      drainMetrics: async () => drained,
      extensionInfo: async () => ({ pools: { 'doc-verify': { busy: 4, waiting: 7, maxConcurrent: 20 } } })
    },
    writeUrl: `http://localhost:${port}/write?db=jmeter`,
    profileOf: () => 'capacity-limited'
  });
  exporter.setRun('RUN-42');
  exporter.event({ service: 'doc-verify', profile: 'brownout', title: 'doc-verify: brownout (timeline x step 2)' });
  const latest = await exporter.flush();
  server.close();

  assert.equal(latest.services['doc-verify'].rps, 100);
  assert.equal(latest.services['doc-verify'].errorRate, 0.04);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].url, '/write?db=jmeter');
  const [event, point] = bodies[0].body.split('\n');
  assert.match(
    event,
    /^virtual_service_events,service=doc-verify,kind=profile,runId=RUN-42 title="doc-verify: brownout \(timeline x step 2\)",profile="brownout" \d+$/
  );
  assert.match(point, /^virtual_service,service=doc-verify,profile=capacity-limited,runId=RUN-42 /);
  assert.match(point, / count=500i,/);
  assert.match(point, /,rps=100,/);
  assert.match(point, /,errors=20i,/);
  assert.match(point, /,busy=4i,waiting=7i,maxConcurrent=20i 1005000000000$/);
});

test('an InfluxDB outage is logged once and never thrown', async () => {
  const warnings = [];
  const exporter = new MetricsExporter({
    wiremock: { drainMetrics: async () => drained, extensionInfo: async () => null },
    writeUrl: 'http://localhost:1/write?db=jmeter',
    log: { warn: (m) => warnings.push(m) }
  });
  await exporter.flush();
  await exporter.flush();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Metrics export .* failed/);
});

test('without the extension, flush is a no-op', async () => {
  const exporter = new MetricsExporter({
    wiremock: { drainMetrics: async () => null, extensionInfo: async () => null }
  });
  assert.equal(await exporter.flush(), null);
});
