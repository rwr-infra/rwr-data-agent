import { config } from './config/index.js';
import { buildApp } from './app.js';

if (config.langfuseEnabled) {
  await import('./instrumentation.js');
}

const app = await buildApp();

export default app;