import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimelineRunner, parseDuration } from '../src/timeline.js';
import { HttpError } from '../src/virtualizer.js';

test('parses durations', () => {
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('90s'), 90000);
  assert.equal(parseDuration('5m'), 300000);
  assert.equal(parseDuration('1.5h'), 5400000);
  assert.equal(parseDuration(2), 2000);
  assert.throws(() => parseDuration('5 minutes'), /Invalid duration/);
  assert.throws(() => parseDuration(-1), /Invalid duration/);
});

function fakeVirtualizer({ failOn } = {}) {
  const calls = [];
  return {
    calls,
    getProfile(name) {
      if (!['healthy', 'brownout'].includes(name)) throw new HttpError(404, `Unknown profile "${name}"`);
      return { name };
    },
    wiremock: { findMappingsByService: async (s) => (s === 'ghost' ? [] : [{}]) },
    async applyProfile(service, profile, { reason }) {
      if (profile === failOn) throw new Error('boom');
      calls.push({ service, profile, reason, t: Date.now() });
    },
    async resetService(service, { reason }) {
      calls.push({ service, profile: 'baseline', reason, t: Date.now() });
    }
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('runs steps in time order and reports progress', async () => {
  const v = fakeVirtualizer();
  const runner = new TimelineRunner({ virtualizer: v });
  const started = await runner.start({
    name: 'demo',
    steps: [
      { at: '200ms', service: 'doc-verify', reset: true },
      { at: 0, service: 'doc-verify', profile: 'healthy' },
      { at: '100ms', service: 'doc-verify', profile: 'brownout' }
    ]
  });
  // The step at 0 is applied before start() returns.
  assert.deepEqual(
    v.calls.map((c) => c.profile),
    ['healthy']
  );
  assert.equal(started.steps[0].status, 'applied');
  assert.equal(started.running, true);

  await wait(320);
  assert.deepEqual(
    v.calls.map((c) => c.profile),
    ['healthy', 'brownout', 'baseline']
  );
  assert.ok(v.calls[1].t - v.calls[0].t >= 90);
  assert.equal(v.calls[1].reason, 'timeline demo step 3');
  const done = runner.current();
  assert.equal(done.state, 'finished');
  assert.equal(done.running, false);
});

test('cancel stops pending steps and can reset services', async () => {
  const v = fakeVirtualizer();
  const runner = new TimelineRunner({ virtualizer: v });
  await runner.start({
    steps: [
      { at: 0, service: 'a', profile: 'brownout' },
      { at: '1h', service: 'a', reset: true }
    ]
  });
  await assert.rejects(runner.start({ steps: [{ at: 0, service: 'a', profile: 'healthy' }] }), /already running/);
  const cancelled = await runner.cancel({ reset: true });
  assert.equal(cancelled.state, 'cancelled');
  assert.deepEqual(
    cancelled.steps.map((s) => s.status),
    ['applied', 'cancelled']
  );
  assert.deepEqual(cancelled.resetServices, ['a']);
  assert.equal(v.calls.at(-1).profile, 'baseline');
});

test('validates the whole timeline before starting', async () => {
  const runner = new TimelineRunner({ virtualizer: fakeVirtualizer() });
  await assert.rejects(runner.start({ steps: [{ at: '5m', service: 'a', profile: 'nope' }] }), /Unknown profile/);
  await assert.rejects(
    runner.start({ steps: [{ at: '5 min', service: 'a', profile: 'healthy' }] }),
    /Invalid duration/
  );
  await assert.rejects(runner.start({ steps: [{ at: 0, service: 'ghost', profile: 'healthy' }] }), /No stubs/);
  await assert.rejects(runner.start({ steps: [{ at: 0, service: 'a' }] }), /exactly one of profile or reset/);
  await assert.rejects(runner.start({ name: '../etc' }), /Body must be/);
  assert.equal(runner.current().running, false);
});

test('a failing step is recorded, later steps still run', async () => {
  const v = fakeVirtualizer({ failOn: 'brownout' });
  const runner = new TimelineRunner({ virtualizer: v });
  await runner.start({
    steps: [
      { at: 0, service: 'a', profile: 'brownout' },
      { at: '50ms', service: 'a', reset: true }
    ]
  });
  await wait(120);
  const state = runner.current();
  assert.equal(state.state, 'finished-with-errors');
  assert.equal(state.steps[0].error, 'boom');
  assert.equal(state.steps[1].status, 'applied');
});
