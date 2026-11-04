// Metrics export, run tagging and timelines end to end: WireMock with the extension, the real
// app wiring, and a fake InfluxDB that captures what is written. Needs WIREMOCK_JAR and
// SV_EXTENSION_JAR; skipped otherwise.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jar = process.env.WIREMOCK_JAR;
const extJar = process.env.SV_EXTENSION_JAR;
const skip = jar && extJar ? false : 'set WIREMOCK_JAR and SV_EXTENSION_JAR to run observability tests';

let wm, server, influx, api, mock, profilesDir, timelinesDir;
const written = [];

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

before(async () => {
  if (skip) return;
  const port = await freePort();
  wm = spawn(
    'java',
    [
      '-cp',
      `${jar}${path.delimiter}${extJar}`,
      'wiremock.Run',
      '--port',
      String(port),
      '--async-response-enabled',
      'true',
      '--disable-banner'
    ],
    { stdio: 'ignore' }
  );
  mock = `http://localhost:${port}`;

  influx = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      written.push(...body.split('\n').filter(Boolean));
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise((r) => influx.listen(0, r));

  profilesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-obs-'));
  await fs.writeFile(
    path.join(profilesDir, 'stressed.yaml'),
    'name: stressed\nlatency:\n  type: fixed\n  ms: 50\nconcurrency:\n  maxConcurrent: 5\nerrors:\n  rate: 0.2\n  responses:\n    - status: 500\n'
  );

  timelinesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-obs-tl-'));
  await fs.copyFile(
    path.join(root, 'timelines', 'doc-verify-brownout.yaml'),
    path.join(timelinesDir, 'doc-verify-brownout.yaml')
  );
  await fs.writeFile(
    path.join(timelinesDir, 'checkout-load.yaml'),
    'name: checkout-load\nsteps:\n  - at: 0\n    service: doc-verify\n    profile: stressed\n  - at: 1h\n    service: doc-verify\n    reset: true\n'
  );

  const built = await buildApp(
    {
      wiremockUrl: mock,
      profilesDir,
      stubsDir: path.join(root, 'stubs'),
      timelinesDir,
      loadStubsOnStart: true,
      waitForWireMock: { attempts: 60, delayMs: 500 },
      saveRecordings: false,
      influxWriteUrl: `http://localhost:${influx.address().port}/write?db=jmeter`,
      metricsIntervalMs: 0 // flushed explicitly by ending the run
    },
    { log: { log() {}, warn() {} } }
  );
  await new Promise((r) => {
    server = built.app.listen(0, r);
  });
  api = `http://localhost:${server.address().port}/api`;
});

after(async () => {
  server?.close();
  influx?.close();
  wm?.kill();
  if (profilesDir) await fs.rm(profilesDir, { recursive: true, force: true });
  if (timelinesDir) await fs.rm(timelinesDir, { recursive: true, force: true });
});

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('health reports metrics export', { skip }, async () => {
  const health = await (await fetch(`${api}/health`)).json();
  assert.equal(health.errorInjection.version, '0.5.0');
  assert.deepEqual(health.metrics, { exporting: true, runId: null });
});

test('a timeline during a tagged run produces metrics and annotations', { skip }, async () => {
  // Drain anything from startup so the interval holds only this test's traffic.
  await post(`${api}/runs`, { runId: 'warmup' });
  await fetch(`${api}/runs/current`, { method: 'DELETE' });
  written.length = 0;

  const run = await (await post(`${api}/runs`, { runId: 'RUN-E2E' })).json();
  assert.equal(run.runId, 'RUN-E2E');
  assert.equal(run.timeline, null);
  const started = await (
    await post(`${api}/timelines`, {
      name: 'e2e',
      steps: [
        { at: 0, service: 'doc-verify', profile: 'stressed' },
        { at: '5s', service: 'doc-verify', reset: true } // after all traffic below has finished
      ]
    })
  ).json();
  assert.equal(started.steps[0].status, 'applied');

  // 200 requests, 10 at a time, against a 5-worker pool with 20% errors.
  for (let i = 0; i < 20; i++) {
    await Promise.all(
      Array.from({ length: 10 }, () =>
        post(`${mock}/v1/documents/verify`, { documentType: 'DL' }).then((r) => r.text())
      )
    );
  }
  const state = await (await fetch(`${api}/timelines/current`)).json();
  assert.equal(state.steps[1].status, 'pending', 'all traffic must run under the stressed profile');
  while ((await (await fetch(`${api}/timelines/current`)).json()).running) await wait(100);

  const ended = await (await fetch(`${api}/runs/current`, { method: 'DELETE' })).json();
  assert.equal(ended.ended, 'RUN-E2E');

  const points = written.filter((l) => l.startsWith('virtual_service,service=doc-verify,'));
  assert.equal(points.length, 1, written.join('\n'));
  const point = points[0];
  assert.match(point, /,runId=RUN-E2E /);
  const field = (name) => Number(new RegExp(`[ ,]${name}=([\\d.]+)i?[ ,]`).exec(point)[1]);
  assert.equal(field('count'), 200);
  assert.ok(Math.abs(field('status5xx') - 40) < 25, `5xx ${field('status5xx')}`);
  assert.equal(field('injected'), field('status5xx'));
  assert.ok(field('queueWaitMax') >= 40, `queue wait max ${field('queueWaitMax')}`);
  assert.ok(field('latencyP50') >= 50);

  const events = written.filter((l) => l.startsWith('virtual_service_events,'));
  assert.equal(events.length, 2, events.join('\n'));
  assert.match(
    events[0],
    /service=doc-verify,kind=profile,runId=RUN-E2E title="doc-verify: stressed \(timeline e2e step 1\)"/
  );
  assert.match(events[1], /title="doc-verify: baseline \(timeline e2e step 2\)"/);

  const latest = await (await fetch(`${api}/metrics/latest`)).json();
  assert.equal(latest.runId, 'RUN-E2E');
  assert.equal(latest.services['doc-verify'].count, 200);
});

test('bundled timeline files are listed', { skip }, async () => {
  const list = await (await fetch(`${api}/timelines`)).json();
  assert.ok(list.some((t) => t.name === 'doc-verify-brownout' && t.steps === 4));
});

test('a run plays the timeline named after its scenario and cleans up when it ends', { skip }, async () => {
  const started = await (await post(`${api}/runs`, { runId: 'R2', scenario: 'Checkout Load' })).json();
  assert.equal(started.timeline, 'checkout-load');
  let services = await (await fetch(`${api}/services`)).json();
  assert.equal(services.find((s) => s.name === 'doc-verify').profile, 'stressed');

  // A late "end" from some other run must not end this one.
  const stale = await (await fetch(`${api}/runs/OTHER`, { method: 'DELETE' })).json();
  assert.equal(stale.ended, null);
  assert.equal((await (await fetch(`${api}/runs/current`)).json()).runId, 'R2');

  const ended = await (await fetch(`${api}/runs/R2`, { method: 'DELETE' })).json();
  assert.equal(ended.ended, 'R2');
  assert.equal(ended.timeline.state, 'cancelled');
  assert.deepEqual(ended.timeline.resetServices, ['doc-verify']);
  services = await (await fetch(`${api}/services`)).json();
  assert.equal(services.find((s) => s.name === 'doc-verify').profile, 'baseline');
});

test('a scenario without a timeline file just tags metrics; a broken one warns', { skip }, async () => {
  const plain = await (await post(`${api}/runs`, { runId: 'R3', scenario: 'No Such Timeline' })).json();
  assert.equal(plain.timeline, null);
  assert.equal(plain.warning, undefined);
  // The bundled doc-verify-brownout timeline uses profiles this test's profile set lacks.
  const broken = await (await post(`${api}/runs`, { runId: 'R4', scenario: 'Doc Verify Brownout' })).json();
  assert.equal(broken.runId, 'R4', 'the run still starts');
  assert.match(broken.warning, /could not start: .*Unknown profile/);
  await fetch(`${api}/runs/current`, { method: 'DELETE' });
});
