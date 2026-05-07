import { buildApp } from '../dist/app.js';

let app: Awaited<ReturnType<typeof buildApp>> | null = null;
let initPromise: Promise<Awaited<ReturnType<typeof buildApp>>> | null = null;

async function getApp() {
  if (app) return app;
  if (!initPromise) initPromise = buildApp();
  app = await initPromise;
  return app;
}

export default async function handler(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
) {
  const server = await getApp();
  await server.ready();
  server.server.emit('request', req, res);
}