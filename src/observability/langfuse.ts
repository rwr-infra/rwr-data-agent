import { Langfuse } from 'langfuse';
import { config } from '../config/index.js';

let langfuse: Langfuse | null = null;

function getClient(): Langfuse | null {
  if (!config.langfuseEnabled) return null;
  if (!langfuse) {
    langfuse = new Langfuse({
      publicKey: config.langfusePublicKey,
      secretKey: config.langfuseSecretKey,
      baseUrl: config.langfuseBaseUrl,
    });
  }
  return langfuse;
}

export interface TraceHandle {
  id: string;
  span(name: string, input?: unknown, metadata?: Record<string, unknown>): SpanHandle;
  event(name: string, data?: Record<string, unknown>): void;
  end(output?: unknown): void;
  error(error: Error): void;
}

export interface SpanHandle {
  end(output?: unknown): void;
  error(error: Error): void;
}

const NOOP_SPAN: SpanHandle = {
  end() {},
  error() {},
};

const NOOP_TRACE: TraceHandle = {
  id: 'noop',
  span: () => NOOP_SPAN,
  event() {},
  end() {},
  error() {},
};

export function createTrace(name: string, input?: unknown, metadata?: Record<string, unknown>): TraceHandle {
  const client = getClient();
  if (!client) return NOOP_TRACE;

  try {
    const trace = client.trace({ name, input, metadata });

    return {
      id: trace.id,
      span(name: string, input?: unknown, metadata?: Record<string, unknown>): SpanHandle {
        try {
          const span = trace.span({ name, input, metadata });
          return {
            end(output?: unknown) {
              try { span.end({ output }); } catch {}
            },
            error(error: Error) {
              try { span.end({ output: error.message, statusMessage: error.message }); } catch {}
            },
          };
        } catch {
          return NOOP_SPAN;
        }
      },
      event(name: string, data?: Record<string, unknown>) {
        try { trace.event({ name, input: data }); } catch {}
      },
      end(output?: unknown) {
        try { trace.update({ output }); } catch {}
      },
      error(error: Error) {
        try { trace.update({ output: error.message, metadata: { ...metadata, error: error.message } }); } catch {}
      },
    };
  } catch {
    return NOOP_TRACE;
  }
}

export async function shutdownLangfuse(): Promise<void> {
  if (langfuse) {
    try {
      await langfuse.shutdownAsync();
    } catch {}
    langfuse = null;
  }
  try {
    const { langfuseSpanProcessor } = await import('../instrumentation.js');
    await langfuseSpanProcessor.forceFlush();
  } catch {}
}
