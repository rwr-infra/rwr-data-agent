import { afterEach, describe, expect, it } from 'vitest';
import {
  buildReflectionTranscript,
  parseReflectionOutput,
  shouldReflect,
  type ReflectionTriggerInput,
} from '../../src/agent/reflect.js';

const base: ReflectionTriggerInput = {
  enabled: true,
  toolFailureCount: 0,
  stopReason: 'completed',
  intent: 'specific',
  hasAnswer: true,
  stoppedByUser: false,
  clientGone: false,
};

afterEach(() => {
  delete process.env.DEBUG_REFLECTION;
});

describe('shouldReflect — refusals', () => {
  it('never reflects while the switch is off, whatever else fired', () => {
    expect(
      shouldReflect({ ...base, enabled: false, toolFailureCount: 3, intent: 'inheritance' }),
    ).toBeNull();
  });

  it('does not reflect on a turn the user stopped', () => {
    expect(shouldReflect({ ...base, stoppedByUser: true, toolFailureCount: 2 })).toBeNull();
    // `stopReason` alone must be enough: the registry flag and the reason are set independently.
    expect(shouldReflect({ ...base, stopReason: 'stopped', toolFailureCount: 2 })).toBeNull();
  });

  it('does not reflect when nobody is left to read it', () => {
    expect(shouldReflect({ ...base, clientGone: true, toolFailureCount: 2 })).toBeNull();
  });

  it('skips a clean turn with no risk signal', () => {
    expect(shouldReflect(base)).toBeNull();
  });

  it('does not reflect on output-limit — a rewrite would hit the same cap', () => {
    expect(shouldReflect({ ...base, stopReason: 'output-limit' })).toBeNull();
  });

  it('skips an empty answer unless the step budget explains it', () => {
    expect(shouldReflect({ ...base, hasAnswer: false, toolFailureCount: 4 })).toBeNull();
    expect(shouldReflect({ ...base, hasAnswer: false, stopReason: 'step-limit' })).toEqual([
      'step-limit',
    ]);
  });
});

describe('shouldReflect — signals', () => {
  it('reports a failed tool call', () => {
    expect(shouldReflect({ ...base, toolFailureCount: 1 })).toEqual(['tool-failure']);
  });

  it('reports the two intents whose output format is hardest to verify', () => {
    expect(shouldReflect({ ...base, intent: 'inheritance' })).toEqual(['intent-inheritance']);
    expect(shouldReflect({ ...base, intent: 'enumeration' })).toEqual(['intent-enumeration']);
    expect(shouldReflect({ ...base, intent: 'comparison' })).toBeNull();
    expect(shouldReflect({ ...base, intent: 'script' })).toBeNull();
  });

  it('accumulates every signal that fired, in a stable order', () => {
    expect(
      shouldReflect({
        ...base,
        toolFailureCount: 2,
        stopReason: 'step-limit',
        hasAnswer: false,
        intent: 'inheritance',
      }),
    ).toEqual(['tool-failure', 'step-limit', 'intent-inheritance']);
  });

  it('DEBUG_REFLECTION=force reflects an otherwise clean turn, but still obeys the refusals', () => {
    process.env.DEBUG_REFLECTION = 'force';
    expect(shouldReflect(base)).toEqual(['forced']);
    expect(shouldReflect({ ...base, enabled: false })).toBeNull();
    expect(shouldReflect({ ...base, clientGone: true })).toBeNull();
  });
});

describe('buildReflectionTranscript', () => {
  it('renders one summarised line per call, pairing results by id', () => {
    const lines = buildReflectionTranscript([
      {
        toolCalls: [
          { toolCallId: 'a', toolName: 'getInheritanceChain', input: { key: 'gkw_g36.weapon' } },
        ],
        toolResults: [
          { toolCallId: 'a', toolName: 'getInheritanceChain', output: { chain: [1, 2] } },
        ],
      },
      {
        toolCalls: [{ toolCallId: 'b', toolName: 'searchDocs', input: { query: 'g36' } }],
        toolResults: [{ toolCallId: 'b', toolName: 'searchDocs', output: { total: 7 } }],
      },
    ]);

    expect(lines).toEqual([
      {
        toolName: 'getInheritanceChain',
        input: 'Inheritance: gkw_g36.weapon',
        result: '2 layer(s)',
        ok: true,
      },
      { toolName: 'searchDocs', input: 'Search: g36', result: '7 result(s)', ok: true },
    ]);
  });

  it('marks a failure as one — the envelope returns errors as ordinary results', () => {
    const [line] = buildReflectionTranscript([
      {
        toolCalls: [{ toolCallId: 'a', toolName: 'getNode', input: { key: 'nope' } }],
        toolResults: [{ toolCallId: 'a', output: { error: 'not found', hint: 'try searchDocs' } }],
      },
    ]);

    expect(line.ok).toBe(false);
    expect(line.result).toBe('not found');
  });

  it('says so when a call never returned, rather than showing an empty result', () => {
    const [line] = buildReflectionTranscript([
      { toolCalls: [{ toolCallId: 'a', toolName: 'findReferences', input: { key: 'x' } }] },
    ]);

    expect(line).toMatchObject({ ok: false, result: 'no result' });
  });
});

/**
 * The backend rejects `responseFormat` (measured: "JSON response format schema is only supported with
 * structuredOutputs"), so the schema cannot constrain generation and this parser is the only thing
 * between a model's prose habits and the wire. Lenient about the sloppiness models actually exhibit,
 * strict about the shape it hands on.
 */
describe('parseReflectionOutput', () => {
  it('reads a clean pass', () => {
    expect(parseReflectionOutput('{"verdict":"pass","issues":[]}')).toEqual({
      verdict: 'pass',
      issues: [],
    });
  });

  it('reads a fail with findings and a rewrite', () => {
    const out = parseReflectionOutput(
      '{"verdict":"fail","issues":[{"code":"missing-citation","detail":"magazine_size has no file"}],"revisedAnswer":"**G36** (`gkw_g36.weapon`) …"}',
    );
    expect(out).toEqual({
      verdict: 'fail',
      issues: [{ code: 'missing-citation', detail: 'magazine_size has no file' }],
      revisedAnswer: '**G36** (`gkw_g36.weapon`) …',
    });
  });

  it('unwraps a ```json fence', () => {
    expect(parseReflectionOutput('```json\n{"verdict":"pass","issues":[]}\n```')?.verdict).toBe(
      'pass',
    );
  });

  it('survives prose on either side of the object', () => {
    expect(
      parseReflectionOutput('Here is my review:\n{"verdict":"pass","issues":[]}\nHope that helps.')
        ?.verdict,
    ).toBe('pass');
  });

  // The measured failure: the model writes snake_case about as often as the kebab-case it was asked
  // for, and a finding dropped over a separator is a finding the user never sees.
  it('folds snake_case and stray casing onto the code set', () => {
    const out = parseReflectionOutput(
      '{"verdict":"fail","issues":[{"code":"Missing_Citation"},{"code":"COUNT MISMATCH"}],"revisedAnswer":"x"}',
    );
    expect(out?.issues.map((i) => i.code)).toEqual(['missing-citation', 'count-mismatch']);
  });

  it('maps a known near-miss code onto the real one', () => {
    const out = parseReflectionOutput(
      '{"verdict":"fail","issues":[{"code":"missing-source"},{"code":"out-of-scope"}],"revisedAnswer":"x"}',
    );
    expect(out?.issues.map((i) => i.code)).toEqual(['missing-citation', 'scope-violation']);
  });

  it('keeps an unrecognised code as `other`, recording what was reported', () => {
    const out = parseReflectionOutput(
      '{"verdict":"fail","issues":[{"code":"tone-too-terse","detail":"reads abruptly"}],"revisedAnswer":"x"}',
    );
    expect(out?.issues[0].code).toBe('other');
    expect(out?.issues[0].detail).toBe('reads abruptly (reported as "tone-too-terse")');
  });

  it('accepts a bare string where an object was asked for', () => {
    const out = parseReflectionOutput(
      '{"verdict":"fail","issues":["missing-key"],"revisedAnswer":"x"}',
    );
    expect(out?.issues).toEqual([{ code: 'missing-key' }]);
  });

  it('treats a blank revisedAnswer as absent, so the caller degrades to a pass', () => {
    expect(parseReflectionOutput('{"verdict":"fail","issues":[],"revisedAnswer":"   "}')).toEqual({
      verdict: 'fail',
      issues: [],
    });
  });

  it('defaults a missing issues array rather than failing the parse', () => {
    expect(parseReflectionOutput('{"verdict":"pass"}')).toEqual({ verdict: 'pass', issues: [] });
  });

  it('returns null on anything it cannot read', () => {
    expect(parseReflectionOutput('')).toBeNull();
    expect(parseReflectionOutput('The answer looks fine to me.')).toBeNull();
    expect(parseReflectionOutput('{"verdict":"pass"')).toBeNull();
    // An unknown verdict is not a verdict: guessing would report a state the model never claimed.
    expect(parseReflectionOutput('{"verdict":"maybe","issues":[]}')).toBeNull();
  });
});
