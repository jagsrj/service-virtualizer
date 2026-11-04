// Capacity (concurrency) modelling end to end, against WireMock with the extension loaded.
// Needs WIREMOCK_JAR and SV_EXTENSION_JAR; skipped otherwise.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Recorder } from '../src/recorder.js';
import { createApp } from '../src/server.js';
import { Virtualizer } from '../src/virtualizer.js';
import { WireMockClient } from '../src/wiremock.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jar = process.env.WIREMOCK_JAR;
const extJar = process.env.SV_EXTENSION_JAR;
const skip = jar && extJar ? false : 'set WIREMOCK_JAR and SV_EXTENSION_JAR to run capacity tests';

let wm, server, api, mock, profilesDir;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const PROFILES = {
  'pool-5': 'latency:\n  type: fixed\n  ms: 200\nconcurrency:\n  maxConcurrent: 5\n',
  'pool-5-queue-10': 'latency:\n  type: fixed\n  ms: 200\nconcurrency:\n  maxConcurrent: 5\n  maxQueue: 10\n',
  'pool-5-timeout-300':
    'latency:\n  type: fixed\n  ms: 200\nconcurrency:\n  maxConcurrent: 5\n  queueTimeoutMs: 300\n  reject:\n    status: 503\n    body: busy\n',
  'pool-5-fast': 'latency:\n  type: fixed\n  ms: 100\nconcurrency:\n  maxConcurrent: 5\n'
};

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
      '--async-response-threads',
      '50',
      '--disable-banner'
    ],
    { stdio: 'ignore' }
  );
  mock = `http://localhost:${port}`;

  profilesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-cap-'));
  for (const [name, body] of Object.entries(PROFILES)) {
    await fs.writeFile(path.join(profilesDir, `${name}.yaml`), `name: ${name}\n${body}`);
  }
  const client = new WireMockClient(mock);
  await client.waitUntilUp({ attempts: 60, delayMs: 500 });
  const virtualizer = new Virtualizer({ wiremock: client, profilesDir, stubsDir: path.join(root, 'stubs') });
  await virtualizer.reloadProfiles();
  await virtualizer.loadStubs();
  await new Promise((resolve) => {
    server = createApp(virtualizer, new Recorder({ virtualizer, save: false })).listen(0, resolve);
  });
  api = `http://localhost:${server.address().port}/api`;

  // Warm up the JVM and the HTTP client.
  await Promise.all(Array.from({ length: 300 }, () => fetch(`${mock}/v2/reports/W`).then((r) => r.text())));
});

after(async () => {
  server?.close();
  wm?.kill();
  if (profilesDir) await fs.rm(profilesDir, { recursive: true, force: true });
});

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const apply = (profile) => post(`${api}/services/credit-bureau/profile`, { profile }).then((r) => r.json());

async function call() {
  const start = performance.now();
  const res = await fetch(`${mock}/v2/reports/C1`);
  const body = await res.text();
  return {
    status: res.status,
    body,
    ms: performance.now() - start,
    rejected: res.headers.get('x-sv-rejected') === 'true',
    queueWait: Number(res.headers.get('x-sv-queue-wait-ms'))
  };
}
const burst = (n) => Promise.all(Array.from({ length: n }, call));

test('requests beyond the pool queue in waves', { skip }, async () => {
  await apply('pool-5');
  const results = (await burst(25)).sort((a, b) => a.ms - b.ms);
  assert.ok(results.every((r) => r.status === 200));
  // 25 requests through 5 workers at 200ms: five waves finishing at ~200, 400 ... 1000ms.
  for (let wave = 0; wave < 5; wave++) {
    const group = results.slice(wave * 5, wave * 5 + 5);
    const expected = 200 * (wave + 1);
    for (const r of group) {
      assert.ok(r.ms >= expected - 15 && r.ms < expected + 150, `wave ${wave + 1}: ${Math.round(r.ms)}ms`);
    }
  }
  assert.equal(results.filter((r) => r.queueWait === 0).length, 5);

  const cap = await (await fetch(`${api}/services/credit-bureau/capacity`)).json();
  assert.equal(cap.limited, true);
  assert.equal(cap.maxConcurrent, 5);
  assert.equal(cap.admitted, 25);
  assert.equal(cap.queued, 20);
  assert.equal(cap.rejected, 0);
});

test('a full queue rejects immediately', { skip }, async () => {
  await apply('pool-5-queue-10');
  const results = await burst(25);
  const ok = results.filter((r) => r.status === 200);
  const rejected = results.filter((r) => r.rejected);
  assert.equal(ok.length, 15);
  assert.equal(rejected.length, 10);
  assert.ok(
    rejected.every((r) => r.status === 503 && r.ms < 150),
    'rejections should be fast'
  );
});

test('requests that would wait past the queue timeout are rejected after it', { skip }, async () => {
  await apply('pool-5-timeout-300');
  const results = await burst(25);
  const ok = results.filter((r) => r.status === 200);
  const rejected = results.filter((r) => r.rejected);
  // Wave 1 waits 0ms, wave 2 waits 200ms (< 300), waves 3-5 would wait 400ms+ (> 300).
  assert.equal(ok.length, 10);
  assert.equal(rejected.length, 15);
  for (const r of rejected) {
    assert.equal(r.body, 'busy');
    assert.ok(r.ms >= 290 && r.ms < 450, `rejected after ${Math.round(r.ms)}ms`);
  }
});

// Closed-loop load: `users` clients, each sending its next request when the last returns.
async function closedLoop(users, durationMs) {
  const end = performance.now() + durationMs;
  const times = [];
  await Promise.all(
    Array.from({ length: users }, async () => {
      while (performance.now() < end) {
        const { ms } = await call();
        // Count only requests that completed inside the window.
        if (performance.now() <= end) times.push(ms);
      }
    })
  );
  times.sort((a, b) => a - b);
  return { throughput: times.length / (durationMs / 1000), p50: times[Math.floor(times.length / 2)] };
}

test("throughput plateaus at capacity and latency grows instead (Little's law)", { skip }, async () => {
  await apply('pool-5-fast'); // capacity = 5 workers / 0.1s = 50 requests/s
  const light = await closedLoop(2, 3000);
  const heavy = await closedLoop(25, 3000);

  // Under capacity: latency is just service time, throughput follows the users.
  assert.ok(light.p50 < 140, `light p50 ${Math.round(light.p50)}ms`);
  assert.ok(Math.abs(light.throughput - 20) / 20 < 0.2, `light throughput ${light.throughput}`);

  // Over capacity: throughput is capped at ~50/s and latency ≈ users / throughput = 500ms.
  assert.ok(Math.abs(heavy.throughput - 50) / 50 < 0.1, `heavy throughput ${heavy.throughput}`);
  assert.ok(Math.abs(heavy.p50 - 500) / 500 < 0.2, `heavy p50 ${Math.round(heavy.p50)}ms`);
});

test('stats report rejections and queue wait', { skip }, async () => {
  await fetch(`${mock}/__admin/requests`, { method: 'DELETE' });
  await apply('pool-5-queue-10');
  await burst(25);
  const stats = await (await fetch(`${api}/services/credit-bureau/stats?limit=100`)).json();
  assert.equal(stats.sampled, 25);
  assert.equal(stats.rejectedRate, 0.4);
  assert.equal(stats.statuses['503'], 10);
  // Two queued waves behind 200ms work: the last waits ~400ms, minus the burst's arrival spread.
  assert.ok(stats.queueWaitMs.max >= 350 && stats.queueWaitMs.max <= 420, JSON.stringify(stats.queueWaitMs));
});

test('reset removes the pool', { skip }, async () => {
  await post(`${api}/services/credit-bureau/reset`);
  const cap = await (await fetch(`${api}/services/credit-bureau/capacity`)).json();
  assert.equal(cap.limited, false);
  const results = await burst(25);
  assert.ok(results.every((r) => r.status === 200 && r.ms < 200));
});
