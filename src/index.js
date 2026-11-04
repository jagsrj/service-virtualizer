import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './server.js';
import { Virtualizer } from './virtualizer.js';
import { WireMockClient } from './wiremock.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const config = {
  port: Number(process.env.PORT ?? 4100),
  wiremockUrl: process.env.WIREMOCK_URL ?? 'http://localhost:8080',
  profilesDir: process.env.PROFILES_DIR ?? path.join(root, 'profiles'),
  stubsDir: process.env.STUBS_DIR ?? path.join(root, 'stubs'),
  loadStubsOnStart: process.env.LOAD_STUBS_ON_START !== 'false'
};

const wiremock = new WireMockClient(config.wiremockUrl);
const virtualizer = new Virtualizer({ wiremock, profilesDir: config.profilesDir, stubsDir: config.stubsDir });

await virtualizer.reloadProfiles();
console.log(`Loaded ${virtualizer.profiles.size} profiles from ${config.profilesDir}`);

if (config.loadStubsOnStart) {
  await wiremock.waitUntilUp();
  const { stubsLoaded, services } = await virtualizer.loadStubs();
  console.log(`Loaded ${stubsLoaded} stubs into WireMock for: ${services.join(', ') || '(none)'}`);
}

createApp(virtualizer).listen(config.port, () => {
  console.log(`service-virtualizer control API on :${config.port} (WireMock at ${config.wiremockUrl})`);
});
