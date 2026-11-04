// End-to-end tests against a real WireMock. Set WIREMOCK_JAR to the standalone jar
// (needs Java 17+); without it these tests are skipped.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.js';
import { Virtualizer } from '../src/virtualizer.js';
import { WireMockClient } from '../src/wiremock.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jar = process.env.WIREMOCK_JAR;
const skip = jar ? false : 'set WIREMOCK_JAR to run integration tests';

let wm, server, api, mock, profilesDir;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

before(async () => {
  if (skip) return;
  const wmPort = await freePort();
  wm = spawn('java', ['-jar', jar, '--port', String(wmPort), '--async-response-enabled', 'true', '--disable-banner'], {
    stdio: 'ignore'
  });
  mock = `http://localhost:${wmPort}`;

  profilesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-profiles-'));
  for (const f of await fs.readdir(path.join(root, 'profiles'))) {
    await fs.copyFile(path.join(root, 'profiles', f), path.join(profilesDir, f));
  }
  await fs.writeFile(path.join(profilesDir, 'fixed-300.yaml'), 'name: fixed-300\nlatency:\n  type: fixed\n  ms: 300\n');

  const client = new WireMockClient(mock);
  await client.waitUntilUp({ attempts: 60, delayMs: 500 });
  const virtualizer = new Virtualizer({ wiremock: client, profilesDir, stubsDir: path.join(root, 'stubs') });
  await virtualizer.reloadProfiles();
  await new Promise((resolve) => {
    server = createApp(virtualizer).listen(0, resolve);
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
const timed = async (fn) => {
  const start = performance.now();
  const res = await fn();
  await res.text();
  return { res, ms: performance.now() - start };
};

test('stubs load and are grouped into services', { skip }, async () => {
  const loaded = await (await post(`${api}/stubs/reload`)).json();
  assert.equal(loaded.stubsLoaded, 4);
  const services = await (await fetch(`${api}/services`)).json();
  assert.deepEqual(services, [
    { name: 'credit-bureau', stubs: 2, profile: 'baseline' },
    { name: 'doc-verify', stubs: 2, profile: 'baseline' }
  ]);
});

test('baseline stub responds with templated body', { skip }, async () => {
  const res = await verify();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.documentType, 'PASSPORT');
  assert.match(body.verificationId, /^[0-9a-f-]{36}$/);
});

test('fixed latency profile adds the delay, reset removes it', { skip }, async () => {
  const applied = await (await post(`${api}/services/doc-verify/profile`, { profile: 'fixed-300' })).json();
  assert.equal(applied.stubsUpdated, 2);
  const slow = await timed(verify);
  assert.equal(slow.res.status, 200);
  assert.ok(slow.ms >= 290, `expected >=300ms, got ${slow.ms}`);

  await post(`${api}/services/doc-verify/reset`);
  const fast = await timed(verify);
  assert.ok(fast.ms < 250, `expected fast after reset, got ${fast.ms}`);
  const services = await (await fetch(`${api}/services`)).json();
  assert.equal(services.find((s) => s.name === 'doc-verify').profile, 'baseline');
});

test('switching profiles does not stack delays', { skip }, async () => {
  await post(`${api}/services/doc-verify/profile`, { profile: 'fixed-300' });
  await post(`${api}/services/doc-verify/profile`, { profile: 'fixed-300' });
  const { ms } = await timed(verify);
  assert.ok(ms < 550, `delay stacked: ${ms}ms`);
  await post(`${api}/services/doc-verify/reset`);
});

test('lognormal profile with cap is accepted by WireMock', { skip }, async () => {
  const res = await post(`${api}/services/credit-bureau/profile`, { profile: 'healthy' });
  assert.equal(res.status, 200);
  const r = await fetch(`${mock}/v2/reports/C123`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).customerId, 'C123');
  await post(`${api}/services/credit-bureau/reset`);
});

test('outage profile returns 503 with the profile body', { skip }, async () => {
  await post(`${api}/services/doc-verify/profile`, { profile: 'outage-503' });
  const res = await verify();
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'service_unavailable');
  await post(`${api}/services/doc-verify/reset`);
});

test('connection-reset profile breaks the connection', { skip }, async () => {
  await post(`${api}/services/doc-verify/profile`, { profile: 'connection-reset' });
  await assert.rejects(verify());
  await post(`${api}/services/doc-verify/reset`);
  assert.equal((await verify()).status, 200);
});

test('stats report served latency per service', { skip }, async () => {
  const stats = await (await fetch(`${api}/services/doc-verify/stats`)).json();
  assert.ok(stats.sampled > 0);
  assert.ok(stats.latencyMs.max >= 290);
  assert.ok(stats.statuses['200'] > 0);
});

test('unmatched requests are visible', { skip }, async () => {
  await fetch(`${mock}/no/such/endpoint`);
  const unmatched = await (await fetch(`${api}/unmatched`)).json();
  assert.ok(unmatched.some((r) => r.url === '/no/such/endpoint'));
});

test('errors are clear', { skip }, async () => {
  const unknownProfile = await post(`${api}/services/doc-verify/profile`, { profile: 'nope' });
  assert.equal(unknownProfile.status, 404);
  const unknownService = await post(`${api}/services/nope/profile`, { profile: 'healthy' });
  assert.equal(unknownService.status, 404);
  const badBody = await post(`${api}/services/doc-verify/profile`, { wrong: 1 });
  assert.equal(badBody.status, 400);
});
