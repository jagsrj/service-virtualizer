import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const config = {
  port: Number(process.env.PORT ?? 4100),
  wiremockUrl: process.env.WIREMOCK_URL ?? 'http://localhost:8080',
  profilesDir: process.env.PROFILES_DIR ?? path.join(root, 'profiles'),
  stubsDir: process.env.STUBS_DIR ?? path.join(root, 'stubs'),
  timelinesDir: process.env.TIMELINES_DIR ?? path.join(root, 'timelines'),
  loadStubsOnStart: process.env.LOAD_STUBS_ON_START !== 'false',
  saveRecordings: process.env.SAVE_RECORDINGS !== 'false',
  influxWriteUrl: process.env.INFLUXDB_WRITE_URL ?? '',
  metricsIntervalMs: Number(process.env.METRICS_INTERVAL_MS ?? 5000)
};

const { app, virtualizer } = await buildApp(config);
console.log(`Loaded ${virtualizer.profiles.size} profiles from ${config.profilesDir}`);
console.log(
  config.influxWriteUrl
    ? `Exporting metrics every ${config.metricsIntervalMs}ms to ${config.influxWriteUrl}`
    : 'INFLUXDB_WRITE_URL not set: metrics are available at /api/metrics/latest only'
);

app.listen(config.port, () => {
  console.log(`service-virtualizer control API on :${config.port} (WireMock at ${config.wiremockUrl})`);
});
