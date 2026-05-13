import 'dotenv/config';
import '../instrumentation.js';
import { buildApp } from '../app.js';
import { config, validateConfig } from '../config/index.js';

async function start() {
  validateConfig();
  const app = await buildApp();

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    console.log(`Server listening on port ${config.port}`);
  } catch (err) {
    console.error('Server failed to start:', err);
    process.exit(1);
  }
}

start();
