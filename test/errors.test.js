// Error injection end to end, against WireMock with the sv-errors extension loaded.
// Needs WIREMOCK_JAR and SV_EXTENSION_JAR (build it with extension/build.sh); skipped otherwise.
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
const skip = jar && extJar ? false : 'set WIREMOCK_JAR and SV_EXTENSION_JAR to run error-injection tests';

let wm, server, api, mock, profilesDir;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const profile = (name, body) => fs.writeFile(path.join(profilesDir, `${name}.yaml`), `name: ${name}\n${body}`);

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

  profilesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-err-'));
  await profile(
    'thirty-pct',
    `errors:
  rate: 0.3
  responses:
    - status: 500
      weight: 1
    - status: 503
      body: '{"error":"down"}'
      weight: 1
`
  );
  await profile('always-reset', 'errors:\n  rate: 1\n  responses:\n    - fault: CONNECTION_RESET_BY_PEER\n');
  await profile(
    'slow-504',
    'latency:\n  type: fixed\n  ms: 5\nerrors:\n  rate: 1\n  responses:\n    - status: 504\n      latencyMs: 400\n'
  );

  const client = new WireMockClient(mock);
  await client.waitUntilUp({ attempts: 60, delayMs: 500 });
  const virtualizer = new Virtualizer({ wiremock: client, profilesDir, stubsDir: path.join(root, 'stubs') });
  await virtualizer.reloadProfiles();
  await virtualizer.loadStubs();
  await new Promise((resolve) => {
    server = createApp(virtualizer, new Recorder({ virtualizer, save: false })).listen(0, resolve);
  });
  api = `http://localhost:${server.address().port}/api`;
});

after(async () => {
  server?.close();
  wm?.kill();
  if (profilesDir) await fs.rm(profilesDir, { recursive: true, force: true });
});

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const verify = () => post(`${mock}/v1/documents/verify`, { documentType: 'PASSPORT' });

test('health reports the extension', { skip }, async () => {
  const health = await (await fetch(`${api}/health`)).json();
  assert.deepEqual(health.errorInjection, { loaded: true, version: '0.3.0' });
});

test('injects errors at the configured rate and weights', { skip }, async () => {
  await fetch(`${mock}/__admin/requests`, { method: 'DELETE' });
  await post(`${api}/services/doc-verify/profile`, { profile: 'thirty-pct' });
  const N = 2000;
  const counts = { 200: 0, 500: 0, 503: 0 };
  let injectedHeader = 0;
  for (let i = 0; i < N / 50; i++) {
    await Promise.all(
      Array.from({ length: 50 }, async () => {
        const res = await verify();
        const body = await res.text();
        counts[res.status] += 1;
        if (res.headers.get('x-sv-injected')) injectedHeader += 1;
        if (res.status === 503) assert.equal(body, '{"error":"down"}');
        if (res.status === 200) assert.equal(JSON.parse(body).documentType, 'PASSPORT', 'templating still works');
      })
    );
  }
  // 30% of 2000 = 600; 4 standard deviations is about ±82.
  const errors = counts[500] + counts[503];
  assert.ok(Math.abs(errors - 600) < 82, `errors ${errors}`);
  assert.ok(Math.abs(counts[500] - counts[503]) < 120, `500s ${counts[500]} vs 503s ${counts[503]}`);
  assert.equal(injectedHeader, errors);

  const stats = await (await fetch(`${api}/services/doc-verify/stats?limit=${N}`)).json();
  assert.equal(stats.sampled, N);
  assert.ok(Math.abs(stats.errorRate - 0.3) < 0.041, `stats errorRate ${stats.errorRate}`);
  assert.equal(stats.injectedRate, stats.errorRate);
});

test('fault errors break the connection', { skip }, async () => {
  await post(`${api}/services/doc-verify/profile`, { profile: 'always-reset' });
  await assert.rejects(verify());
});

test('per-error latency overrides the profile latency', { skip }, async () => {
  await post(`${api}/services/doc-verify/profile`, { profile: 'slow-504' });
  const start = performance.now();
  const res = await verify();
  await res.text();
  assert.equal(res.status, 504);
  assert.ok(performance.now() - start >= 390, `took ${Math.round(performance.now() - start)}ms`);
});

test('reset removes error injection', { skip }, async () => {
  await post(`${api}/services/doc-verify/reset`);
  const results = await Promise.all(Array.from({ length: 100 }, () => verify().then((r) => r.status)));
  assert.ok(results.every((s) => s === 200));
  const [mapping] = (await (await fetch(`${mock}/__admin/mappings`)).json()).mappings.filter(
    (m) => m.request.urlPath === '/v1/documents/verify'
  );
  assert.deepEqual(mapping.response.transformers, ['response-template']);
});
