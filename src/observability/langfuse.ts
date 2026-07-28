import { trace } from '@opentelemetry/api';

const TRACER_NAME = 'rwr-data-agent';

export function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

export async function flushLangfuse(): Promise<void> {
  try {
    const { langfuseSpanProcessor } = await import('../instrumentation.js');
    await langfuseSpanProcessor.forceFlush();
  } catch {
    // Tracing is best-effort; a flush failure must never fail the request.
  }
}

export async function shutdownLangfuse(): Promise<void> {
  try {
    const { langfuseSpanProcessor } = await import('../instrumentation.js');
    await langfuseSpanProcessor.forceFlush();
    await langfuseSpanProcessor.shutdown();
  } catch {
    // Tracing is best-effort; a shutdown failure must never block process exit.
  }
}
