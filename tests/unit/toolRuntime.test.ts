import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool, ToolCallOptions } from 'ai';
import { config } from '../../src/config/index.js';
import { instrumentTools, isToolFailure, repairToolCall } from '../../src/agent/toolRuntime.js';

beforeEach(() => {
  // The envelope logs every call outcome; keep the test output readable.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

/** `ToolCallOptions` carries more than the envelope reads; only `messages` and the signal matter. */
function callOptions(messages: unknown[] = [], abortSignal?: AbortSignal): ToolCallOptions {
  return { toolCallId: 'call-1', messages, abortSignal } as unknown as ToolCallOptions;
}

/** An assistant message replaying an earlier tool call, which is what the duplicate guard scans. */
function priorCall(toolName: string, input: unknown) {
  return { role: 'assistant', content: [{ type: 'tool-call', toolName, input }] };
}

describe('isToolFailure', () => {
  it('reads failure off the output shape, not the stream part type', () => {
    expect(isToolFailure({ error: 'boom', hint: 'try X' })).toBe(true);
    expect(isToolFailure({ results: [] })).toBe(false);
    expect(isToolFailure(null)).toBe(false);
    expect(isToolFailure(undefined)).toBe(false);
    expect(isToolFailure('error')).toBe(false);
  });
});

describe('repairToolCall', () => {
  const tools = { searchDocs: {}, readSource: {}, listFiles: {} } as unknown as Record<
    string,
    Tool
  >;

  const repair = (toolName: string, input: string) =>
    repairToolCall({
      toolCall: { type: 'tool-call', toolCallId: 'c1', toolName, input },
      tools,
    } as never);

  it('remaps unambiguous coding-agent habits onto the real tool', async () => {
    await expect(repair('grep', JSON.stringify({ pattern: 'g36' }))).resolves.toMatchObject({
      toolName: 'searchDocs',
      input: JSON.stringify({ query: 'g36' }),
    });
    await expect(
      repair('cat', JSON.stringify({ path: 'weapons/m4a1.weapon' })),
    ).resolves.toMatchObject({
      toolName: 'readSource',
      input: JSON.stringify({ file: 'weapons/m4a1.weapon' }),
    });
    await expect(repair('ls', JSON.stringify({ glob: '*.weapon' }))).resolves.toMatchObject({
      toolName: 'listFiles',
    });
  });

  it('is case-insensitive on the hallucinated name', async () => {
    await expect(repair('GREP', JSON.stringify({ query: 'g36' }))).resolves.not.toBeNull();
  });

  /**
   * The alias table exists to save a wasted step, NOT to widen the tool surface. A write, shell or
   * exec name must never resolve to anything — this project is deliberately not a coding agent, and
   * an alias is the cheapest possible way to accidentally make it one.
   */
  it('never maps a write, shell or exec name', async () => {
    const forbidden = [
      'write',
      'write_file',
      'edit',
      'edit_file',
      'apply_patch',
      'create_file',
      'rm',
      'delete',
      'mv',
      'cp',
      'mkdir',
      'chmod',
      'bash',
      'sh',
      'zsh',
      'shell',
      'exec',
      'execute',
      'execute_command',
      'run',
      'run_command',
      'spawn',
      'process',
      'eval',
      'python',
      'node',
      'curl',
      'fetch',
    ];
    for (const name of forbidden) {
      await expect(
        repair(name, JSON.stringify({ command: 'rm -rf /', path: 'x', query: 'x' })),
      ).resolves.toBeNull();
    }
  });

  it('returns null when the intent is not recoverable', async () => {
    // Unknown name — NoSuchToolError already lists the real tools and the model self-corrects.
    await expect(repair('frobnicate', '{}')).resolves.toBeNull();
    // Malformed arguments.
    await expect(repair('grep', 'not json')).resolves.toBeNull();
    // No usable string argument under any of the alias' known keys.
    await expect(repair('grep', JSON.stringify({ limit: 5 }))).resolves.toBeNull();
    await expect(repair('grep', JSON.stringify({ query: '' }))).resolves.toBeNull();
  });

  it('returns null when the aliased target is not in the registry', async () => {
    await expect(
      repairToolCall({
        toolCall: { type: 'tool-call', toolCallId: 'c1', toolName: 'grep', input: '{"query":"x"}' },
        tools: {} as Record<string, Tool>,
      } as never),
    ).resolves.toBeNull();
  });
});

describe('instrumentTools', () => {
  const wrap = (execute: Tool['execute']) =>
    instrumentTools({ probe: { description: 'd', execute } as unknown as Tool });

  it('leaves a tool without an execute alone', () => {
    const original = { description: 'client-side tool' } as unknown as Tool;
    expect(instrumentTools({ probe: original }).probe).toBe(original);
  });

  it('passes a successful result straight through', async () => {
    const tools = wrap(() => Promise.resolve({ results: [1] }));
    await expect(tools.probe.execute!({}, callOptions())).resolves.toEqual({ results: [1] });
  });

  /**
   * Nothing a tool throws may escape: it has to reach the model as an ordinary result it can route
   * around, which is also why a tool must never wrap itself in try/catch — catching there looks
   * like success to this envelope and the error loses its recovery hint.
   */
  it('converts a throw into a failure envelope with a hint', async () => {
    const tools = wrap(() => {
      throw new Error('something broke');
    });
    const out = (await tools.probe.execute!({}, callOptions())) as { error: string; hint: string };
    expect(out.error).toBe('something broke');
    expect(out.hint).toBeTruthy();
    expect(isToolFailure(out)).toBe(true);
  });

  it('names the way out for the failures that have one', async () => {
    const hintFor = async (message: string) => {
      const tools = wrap(() => {
        throw new Error(message);
      });
      return (await tools.probe.execute!({}, callOptions())) as { hint: string };
    };

    expect((await hintFor('Path traversal blocked: ../../etc/passwd')).hint).toContain(
      'game data root',
    );
    expect((await hintFor('File not found: x.weapon')).hint).toContain('getNode');
    expect((await hintFor('Timed out after 15000ms')).hint).toContain('Narrow');
  });

  it('rejects a verbatim repeat instead of replaying the cached result', async () => {
    const execute = vi.fn(() => Promise.resolve({ ok: true }));
    const tools = wrap(execute);
    const input = { key: 'gkw_g36' };

    const out = (await tools.probe.execute!(input, callOptions([priorCall('probe', input)]))) as {
      error: string;
      hint: string;
    };

    expect(out.error).toBe('duplicate_call');
    expect(execute).not.toHaveBeenCalled();
  });

  // Argument key order is not meaningful — `{query, limit}` and `{limit, query}` are the same call.
  it('compares arguments structurally, not by serialization order', async () => {
    const tools = wrap(() => Promise.resolve({ ok: true }));
    const out = (await tools.probe.execute!(
      { query: 'g36', limit: 5 },
      callOptions([priorCall('probe', { limit: 5, query: 'g36' })]),
    )) as { error: string };
    expect(out.error).toBe('duplicate_call');
  });

  it('escalates the wording once the model has ignored the first rejection', async () => {
    const tools = wrap(() => Promise.resolve({ ok: true }));
    const input = { key: 'gkw_g36' };

    const first = (await tools.probe.execute!(input, callOptions([priorCall('probe', input)]))) as {
      hint: string;
    };
    const second = (await tools.probe.execute!(
      input,
      callOptions([priorCall('probe', input), priorCall('probe', input)]),
    )) as { hint: string };

    expect(first.hint).toContain('re-read it');
    // A model that repeats twice will not leave the loop on a politely-worded suggestion.
    expect(second.hint).toContain('Stop calling it');
    expect(second.hint).toContain('evidence already gathered');
  });

  it('does not confuse a different tool or different arguments for a repeat', async () => {
    const tools = wrap(() => Promise.resolve({ ok: true }));
    const input = { key: 'gkw_g36' };

    await expect(
      tools.probe.execute!(input, callOptions([priorCall('otherTool', input)])),
    ).resolves.toEqual({ ok: true });
    await expect(
      tools.probe.execute!(input, callOptions([priorCall('probe', { key: 'ak47' })])),
    ).resolves.toEqual({ ok: true });
  });

  it('fails a tool that outruns the deadline', async () => {
    const previous = config.toolTimeoutMs;
    // Read once, at registry-build time — so it has to be set before instrumentTools runs.
    config.toolTimeoutMs = 20;
    try {
      const tools = wrap(() => new Promise(() => {}));
      const out = (await tools.probe.execute!({}, callOptions())) as {
        error: string;
        hint: string;
      };
      expect(out.error).toContain('Timed out after 20ms');
      expect(out.hint).toContain('Narrow');
    } finally {
      config.toolTimeoutMs = previous;
    }
  });

  it('fails a tool when the request aborts under it', async () => {
    const controller = new AbortController();
    const tools = wrap(() => new Promise(() => {}));
    const pending = tools.probe.execute!(
      {},
      callOptions([], controller.signal),
    ) as Promise<unknown>;
    controller.abort();
    await expect(pending).resolves.toEqual(expect.objectContaining({ error: 'Request aborted' }));
  });

  it('fails immediately when the signal was already aborted', async () => {
    const tools = wrap(() => new Promise(() => {}));
    const out = (await tools.probe.execute!({}, callOptions([], AbortSignal.abort()))) as {
      error: string;
    };
    expect(out.error).toBe('Request aborted');
  });

  // measureToolDefTokens keys its cache on the registry object, so this must be a new reference.
  it('returns a new registry object', () => {
    const input = {
      probe: { description: 'd', execute: () => Promise.resolve(1) } as unknown as Tool,
    };
    expect(instrumentTools(input)).not.toBe(input);
  });
});
