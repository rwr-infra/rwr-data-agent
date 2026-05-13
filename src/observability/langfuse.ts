import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { config } from '../config/index.js';

const TRACER_NAME = 'rwr-data-agent';

export function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

export async function flushLangfuse(): Promise<void> {
  try {
    const { langfuseSpanProcessor } = await import('../instrumentation.js');
    await langfuseSpanProcessor.forceFlush();
  } catch {}
}

export async function shutdownLangfuse(): Promise<void> {
  try {
    const { langfuseSpanProcessor } = await import('../instrumentation.js');
    await langfuseSpanProcessor.forceFlush();
    await langfuseSpanProcessor.shutdown();
  } catch {}
}
