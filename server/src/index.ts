import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { loadConfig } from './config';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on the real environment.
}

const here = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig(process.env);
if (config.production) config.staticDir = path.resolve(here, '../client');

const app = createApp(config);
const port = await app.listen();

const lanAddresses = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal)
  .map((a) => a!.address);

console.log(`Split Steering server listening on http://${config.host}:${port}`);
console.log(`  mode: ${config.production ? 'production' : 'development'}`);
console.log(`  public origin: ${config.publicOrigin ?? '(not set, using the browser origin)'}`);
console.log(`  keyboard simulation: ${config.simEnabled ? 'ENABLED' : 'disabled'}`);
if (!config.production) {
  for (const ip of lanAddresses) console.log(`  LAN (dev client): http://${ip}:${process.env.CLIENT_DEV_PORT ?? 5173}`);
}

const shutdown = () => {
  console.log('Shutting down...');
  app.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
