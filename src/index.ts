import { buildApp } from './app.js';
import { config } from './config/index.js';

const app = await buildApp();

try {
  const address = await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`Server listening on ${address}`);
} catch {
  console.log('Running in Vercel serverless mode (listen skipped)');
}

export default app;