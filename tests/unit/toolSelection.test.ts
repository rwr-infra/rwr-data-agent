import { describe, expect, it } from 'vitest';
import { selectActiveTools, type ToolDisclosureMeta } from '../../src/agent/toolSelection.js';

const CORE = ['getNode', 'searchDocs', 'readSource'];

function meta(pluginNames: string[], triggers: Record<string, string[]> = {}): ToolDisclosureMeta {
  return {
    coreNames: CORE,
    allNames: [...CORE, ...pluginNames],
    // Normalized by the loader (trimmed, lowercased) before it ever reaches this module.
    pluginTriggers: new Map(
      Object.entries(triggers).map(([name, ts]) => [name, ts.map((t) => t.trim().toLowerCase())]),
    ),
  };
}

describe('selectActiveTools — full disclosure (undefined = SDK sees every tool)', () => {
  const m = meta(['a', 'b', 'c'], { a: ['upgrade'] });

  it('keeps full disclosure without metadata', () => {
    expect(selectActiveTools(undefined, 'anything', 0, 2)).toBeUndefined();
  });

  it('keeps full disclosure when the threshold disables it', () => {
    expect(selectActiveTools(m, 'anything', 0, 0)).toBeUndefined();
  });

  // Below the threshold this module must be a byte-for-byte no-op, not "the same set spelled out".
  it('keeps full disclosure while the registry fits the threshold', () => {
    expect(selectActiveTools(m, 'anything', 0, m.allNames.length)).toBeUndefined();
    expect(selectActiveTools(m, 'anything', 0, m.allNames.length + 1)).toBeUndefined();
  });

  it('keeps full disclosure after the first step', () => {
    expect(selectActiveTools(m, 'anything', 1, 2)).toBeUndefined();
    expect(selectActiveTools(m, 'anything', 7, 2)).toBeUndefined();
  });
});

describe('selectActiveTools — narrowing the first step', () => {
  it('always exposes the built-ins', () => {
    const active = selectActiveTools(meta(['a'], { a: ['upgrade'] }), 'unrelated question', 0, 2);
    expect(active).toEqual(expect.arrayContaining(CORE));
  });

  it('exposes a plugin whose trigger matched', () => {
    const active = selectActiveTools(
      meta(['lookupUpgrade'], { lookupUpgrade: ['upgrade', '升级'] }),
      'G36 的升级链是什么',
      0,
      2,
    );
    expect(active).toContain('lookupUpgrade');
  });

  it('hides a plugin whose triggers all missed', () => {
    const active = selectActiveTools(
      meta(['lookupUpgrade'], { lookupUpgrade: ['upgrade', '升级'] }),
      'G36 的伤害是多少',
      0,
      2,
    );
    expect(active).not.toContain('lookupUpgrade');
  });

  it('matches triggers case-insensitively', () => {
    const active = selectActiveTools(
      meta(['t'], { t: ['upgrade'] }),
      'What is the UPGRADE chain?',
      0,
      2,
    );
    expect(active).toContain('t');
  });

  /**
   * Declaring `triggers` is an author opt-in to being hidden. A plugin that declared none is
   * absent from `pluginTriggers` and must stay visible — otherwise every existing plugin silently
   * disappears from the first step the moment `tools.d/` grows past the threshold, which is the
   * opposite of what both this module's doc comment and AGENTS.md promise.
   */
  it('never hides a plugin that declared no triggers', () => {
    const active = selectActiveTools(
      meta(['noTriggers', 'withTriggers'], { withTriggers: ['upgrade'] }),
      'a query matching nothing',
      0,
      2,
    );
    expect(active).toContain('noTriggers');
    expect(active).not.toContain('withTriggers');
  });

  it('never returns a name twice', () => {
    const active = selectActiveTools(meta(['a'], { a: ['x'] }), 'x', 0, 2)!;
    expect(new Set(active).size).toBe(active.length);
  });

  it('only ever returns names that are actually registered', () => {
    const m = meta(['a', 'b'], { a: ['x'], b: ['y'] });
    const active = selectActiveTools(m, 'x y', 0, 2)!;
    for (const name of active) expect(m.allNames).toContain(name);
  });
});
