// Record mode end to end: a fake "real" dependency with known lognormal latency sits
// behind WireMock. Needs WIREMOCK_JAR (Java 17+); skipped otherwise.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { Recorder } from '../src/recorder.js';
import { createApp } from '../src/server.js';
import { Virtualizer } from '../src/virtualizer.js';
import { WireMockClient } from '../src/wiremock.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jar = process.env.WIREMOCK_JAR;
const skip = jar ? false : 'set WIREMOCK_JAR to run recording tests';

const MEDIAN = 100;
const SIGMA = 0.4; // expected p95 = 100 * e^(0.4 * 1.645) ≈ 193ms
const REQUESTS = 400;

let wm, upstream, server, api, mock, upstreamUrl, workDir;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

function startUpstream() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const z = Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
        setTimeout(
          () => {
            res.setHeader('Content-Type', 'application/json');
            if (req.method === 'POST') {
              res.end(JSON.stringify({ paymentId: 'P-1', received: JSON.parse(body || '{}') }));
            } else {
              res.end(JSON.stringify({ path: req.url, balance: 1234.56 }));
            }
          },
          MEDIAN * Math.exp(SIGMA * z)
        );
      });
    });
    srv.listen(0, () => resolve(srv));
  });
}

before(async () => {
  if (skip) return;
  const wmPort = await freePort();
  wm = spawn('java', ['-jar', jar, '--port', String(wmPort), '--async-response-enabled', 'true', '--disable-banner'], {
    stdio: 'ignore'
  });
  mock = `http://localhost:${wmPort}`;
  upstream = await startUpstream();
  upstreamUrl = `http://localhost:${upstream.address().port}`;

  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-rec-'));
  await fs.cp(path.join(root, 'profiles'), path.join(workDir, 'profiles'), { recursive: true });
  await fs.mkdir(path.join(workDir, 'stubs'));

  const client = new WireMockClient(mock);
  await client.waitUntilUp({ attempts: 60, delayMs: 500 });
  const virtualizer = new Virtualizer({
    wiremock: client,
    profilesDir: path.join(workDir, 'profiles'),
    stubsDir: path.join(workDir, 'stubs')
  });
  await virtualizer.reloadProfiles();
  const recorder = new Recorder({ virtualizer, save: true });
  await new Promise((resolve) => {
    server = createApp(virtualizer, recorder).listen(0, resolve);
  });
  api = `http://localhost:${server.address().port}/api`;

  // Warm up the JVM so proxy overhead does not distort the recorded latencies.
  await fs.writeFile(path.join(workDir, 'stubs', '.keep'), '');
  await Promise.all(Array.from({ length: 200 }, () => fetch(`${mock}/__admin/health`).then((r) => r.text())));
});

after(async () => {
  server?.close();
  upstream?.close();
  wm?.kill();
  if (workDir) await fs.rm(workDir, { recursive: true, force: true });
});

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

test('rejects bad recording requests', { skip }, async () => {
  assert.equal((await post(`${api}/recordings/stop`)).status, 409);
  assert.equal((await post(`${api}/recordings/start`, { service: 'Bad Name', targetUrl: upstreamUrl })).status, 400);
  assert.equal((await post(`${api}/recordings/start`, { service: 'ok', targetUrl: 'not a url' })).status, 400);
});

test('records stubs and fits a profile to the real latency', { skip }, async () => {
  const started = await (
    await post(`${api}/recordings/start`, { service: 'core-banking', targetUrl: upstreamUrl })
  ).json();
  assert.equal(started.recording, true);
  assert.equal((await post(`${api}/recordings/start`, { service: 'other', targetUrl: upstreamUrl })).status, 409);

  const paths = ['/accounts/1', '/accounts/2', '/accounts/3'];
  for (let i = 0; i < REQUESTS / 40; i++) {
    await Promise.all(
      Array.from({ length: 40 }, (_, j) =>
        j % 4 === 3
          ? post(`${mock}/payments`, { amount: 100, currency: 'CAD' }).then((r) => r.text())
          : fetch(`${mock}${paths[j % 4]}`).then((r) => r.text())
      )
    );
  }

  const result = await (await post(`${api}/recordings/stop`)).json();
  assert.equal(result.stubsRecorded, 4, JSON.stringify(result));
  assert.equal(result.samples, REQUESTS);

  const { latency } = result.fit.profile;
  assert.equal(latency.type, 'lognormal');
  const expectedP95 = MEDIAN * Math.exp(SIGMA * 1.6449);
  assert.ok(Math.abs(latency.p50Ms - MEDIAN) / MEDIAN < 0.2, `p50 ${latency.p50Ms}`);
  assert.ok(Math.abs(result.fit.observedMs.p95 - expectedP95) / expectedP95 < 0.25, `p95 ${result.fit.observedMs.p95}`);

  // Files land in stubs/ and profiles/ so they can be committed.
  const stubFile = JSON.parse(await fs.readFile(path.join(workDir, result.stubsFile), 'utf8'));
  assert.equal(stubFile.mappings.length, 4);
  assert.ok(stubFile.mappings.every((m) => m.metadata.service === 'core-banking'));
  const savedProfile = YAML.parse(await fs.readFile(path.join(workDir, result.profileFile), 'utf8'));
  assert.equal(savedProfile.name, 'core-banking-recorded');
  const profiles = await (await fetch(`${api}/profiles`)).json();
  assert.ok(profiles.some((p) => p.name === 'core-banking-recorded'));
});

test('recorded stubs answer without the real dependency', { skip }, async () => {
  upstream.close();
  upstream.closeAllConnections?.();
  const res = await fetch(`${mock}/accounts/2`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { path: '/accounts/2', balance: 1234.56 });
  const pay = await post(`${mock}/payments`, { amount: 100, currency: 'CAD' });
  assert.equal((await pay.json()).paymentId, 'P-1');

  const services = await (await fetch(`${api}/services`)).json();
  assert.deepEqual(services, [{ name: 'core-banking', stubs: 4, profile: 'baseline' }]);
});

test('the fitted profile reproduces the recorded latency', { skip }, async () => {
  const fitted = (await (await fetch(`${api}/profiles/core-banking-recorded`)).json()).expectedMs;
  const applied = await (
    await post(`${api}/services/core-banking/profile`, { profile: 'core-banking-recorded' })
  ).json();
  assert.equal(applied.stubsUpdated, 4);
  const times = [];
  for (let i = 0; i < 10; i++) {
    await Promise.all(
      Array.from({ length: 30 }, async () => {
        const start = performance.now();
        await (await fetch(`${mock}/accounts/1`)).text();
        times.push(performance.now() - start);
      })
    );
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.ceil(0.5 * times.length) - 1];
  // Replay adds WireMock's own processing time (a few ms on real hardware) on top of the profile.
  assert.ok(
    p50 >= fitted.p50 * 0.9 && p50 <= fitted.p50 * 1.3,
    `replayed p50 ${Math.round(p50)}ms vs fitted ${fitted.p50}ms`
  );
});

test('fit endpoint accepts samples from other sources', { skip }, async () => {
  const samplesMs = Array.from({ length: 200 }, (_, i) => 40 + (i % 50) * 3);
  const res = await post(`${api}/profiles/fit`, { name: 'from-jtl', samplesMs, save: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.profile.name, 'from-jtl');
  assert.equal(body.profileFile, 'profiles/from-jtl.yaml');
  // Never overwrite an existing profile unless asked to.
  assert.equal((await post(`${api}/profiles/fit`, { name: 'healthy', samplesMs, save: true })).status, 409);
  assert.equal((await post(`${api}/profiles/fit`, { name: 'from-jtl', samplesMs, save: true })).status, 409);
  const again = await post(`${api}/profiles/fit`, { name: 'from-jtl', samplesMs, save: true, overwrite: true });
  assert.equal(again.status, 200);
  assert.equal((await post(`${api}/profiles/fit`, { name: 'x', samplesMs: [] })).status, 400);
});
