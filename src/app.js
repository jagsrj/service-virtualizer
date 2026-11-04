// Wires the pieces together. Used by src/index.js and by the end-to-end tests,
// so tests exercise exactly what production runs.
import { MetricsExporter } from './metrics.js';
import { Recorder } from './recorder.js';
import { RunTracker } from './runs.js';
import { createApp } from './server.js';
import { TimelineRunner } from './timeline.js';
import { Virtualizer } from './virtualizer.js';
import { WireMockClient } from './wiremock.js';

export async function buildApp(config, { log = console } = {}) {
  const wiremock = new WireMockClient(config.wiremockUrl);
  const virtualizer = new Virtualizer({ wiremock, profilesDir: config.profilesDir, stubsDir: config.stubsDir });
  await virtualizer.reloadProfiles();

  if (config.loadStubsOnStart) {
    await wiremock.waitUntilUp(config.waitForWireMock);
    const { stubsLoaded, services } = await virtualizer.loadStubs();
    log.log(`Loaded ${stubsLoaded} stubs into WireMock for: ${services.join(', ') || '(none)'}`);
  }
  await virtualizer.syncActiveProfiles().catch(() => {});

  const recorder = new Recorder({ virtualizer, save: config.saveRecordings });
  const timelines = new TimelineRunner({ virtualizer, timelinesDir: config.timelinesDir });
  const metrics = new MetricsExporter({
    wiremock,
    writeUrl: config.influxWriteUrl,
    intervalMs: config.metricsIntervalMs,
    profileOf: (service) => virtualizer.profileOf(service),
    log
  });
  virtualizer.onChange(({ service, profile, reason }) =>
    metrics.event({ service, profile, title: `${service}: ${profile} (${reason})` })
  );
  if (config.metricsIntervalMs > 0) metrics.start();

  const runs = new RunTracker({ metrics, timelines });
  const app = createApp(virtualizer, recorder, { metrics, timelines, runs });
  return { app, wiremock, virtualizer, recorder, timelines, metrics, runs };
}
