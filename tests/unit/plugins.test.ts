import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config/index.js';
import { loadToolPlugins, type ToolHost } from '../../src/agent/plugins.js';

/**
 * The loader is what a third-party plugin ecosystem actually stands on: no shadowing of built-ins,
 * one bad file never taking the others down, and triggers normalized exactly once. Deterministic
 * and cheap — real files in a temp dir, no LLM, no index.
 */

let dir: string;
let previousToolsDir: string;

/** The loader only forwards the host to the factory, so a stub keeps the graph out of these tests. */
const host = { scope: undefined, log: () => {} } as unknown as ToolHost;

const BUILTINS = ['getNode', 'searchDocs', 'readSource'];

async function writePlugin(file: string, body: string) {
  await fs.writeFile(path.join(dir, file), body, 'utf8');
}

/** A plugin file exporting one spec, with `extra` merged over the defaults. */
function specSource(name: string, extra = ''): string {
  return `export default function register(host) {
  return [{
    name: ${JSON.stringify(name)},
    description: 'does a thing',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    ${extra}
    execute: async ({ q }) => ({ echoed: q }),
  }];
}
`;
}

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rwr-plugins-'));
  previousToolsDir = config.toolsDir;
  config.toolsDir = dir;
});

afterEach(async () => {
  config.toolsDir = previousToolsDir;
  await fs.rm(dir, { recursive: true, force: true });
});

describe('loadToolPlugins — discovery', () => {
  it('treats a missing plugin directory as no plugins, not an error', async () => {
    config.toolsDir = path.join(dir, 'does-not-exist');
    const loaded = await loadToolPlugins(host, BUILTINS);
    expect(loaded.tools).toEqual({});
    expect(loaded.entries).toEqual([]);
  });

  it('loads a valid plugin and reports it', async () => {
    await writePlugin('good.js', specSource('myTool'));
    const loaded = await loadToolPlugins(host, BUILTINS);

    expect(Object.keys(loaded.tools)).toEqual(['myTool']);
    expect(loaded.entries).toEqual([
      expect.objectContaining({ name: 'myTool', file: 'good.js', description: 'does a thing' }),
    ]);
    expect(loaded.entries[0].error).toBeUndefined();
  });

  it('skips files that are not loadable plugins', async () => {
    await writePlugin('_partial.js', specSource('hidden'));
    await writePlugin('.dotfile.js', specSource('dotted'));
    await writePlugin('notes.txt', 'not a module');
    await writePlugin('real.js', specSource('real'));

    const loaded = await loadToolPlugins(host, BUILTINS);
    expect(Object.keys(loaded.tools)).toEqual(['real']);
    expect(loaded.entries).toHaveLength(1);
  });
});

describe('loadToolPlugins — the rules a plugin cannot break', () => {
  // An external file must never be able to hijack core behaviour.
  it('refuses to let a plugin shadow a built-in', async () => {
    await writePlugin('shadow.js', specSource('getNode'));
    const loaded = await loadToolPlugins(host, BUILTINS);

    expect(loaded.tools.getNode).toBeUndefined();
    expect(loaded.entries[0].error).toContain('collides with a built-in');
  });

  it('refuses a duplicate name and keeps the first', async () => {
    await writePlugin('a-first.js', specSource('dupe'));
    await writePlugin('b-second.js', specSource('dupe'));
    const loaded = await loadToolPlugins(host, BUILTINS);

    expect(Object.keys(loaded.tools)).toEqual(['dupe']);
    expect(loaded.entries[1].error).toContain('duplicate tool name');
  });

  /**
   * The name pattern admits every one of these, and on a plain object they are not free names:
   * `toString` and `constructor` read as already-taken off `Object.prototype`, so the first plugin to
   * use one would be rejected as a duplicate of nothing; `__proto__` would not be stored as an own
   * property at all, so the tool would vanish from the host's `{...tools}` spread with no error
   * entry recording it. Names nobody sensible would pick — but a registry that mangles them is a
   * registry that mangles them silently.
   */
  it.each(['toString', 'constructor', 'valueOf', '__proto__'])(
    'registers %s as an ordinary tool name',
    async (name) => {
      await writePlugin('proto.js', specSource(name));
      const loaded = await loadToolPlugins(host, BUILTINS);

      expect(loaded.entries[0].error).toBeUndefined();
      expect(Object.keys(loaded.tools)).toEqual([name]);
    },
  );

  it.each([
    ['an invalid tool name', specSource('not a valid name'), 'invalid tool name'],
    [
      'an empty description',
      `export default () => [{ name: 'x', description: '  ', inputSchema: {}, execute: () => 1 }];`,
      'non-empty description',
    ],
    [
      'a missing inputSchema',
      `export default () => [{ name: 'x', description: 'd', execute: () => 1 }];`,
      'JSON Schema inputSchema',
    ],
    [
      'a missing execute',
      `export default () => [{ name: 'x', description: 'd', inputSchema: {} }];`,
      'execute function',
    ],
    [
      'empty triggers',
      `export default () => [{ name: 'x', description: 'd', inputSchema: {}, triggers: [], execute: () => 1 }];`,
      'non-empty array',
    ],
    [
      'a non-string trigger',
      `export default () => [{ name: 'x', description: 'd', inputSchema: {}, triggers: [3], execute: () => 1 }];`,
      'non-empty array',
    ],
    [
      'a non-function default export',
      `export default { name: 'x' };`,
      'default export must be a function',
    ],
    ['a syntax error', `export default function ( {{{`, ''],
  ])('rejects %s', async (_label, source, expectedError) => {
    await writePlugin('bad.js', source);
    const loaded = await loadToolPlugins(host, BUILTINS);

    expect(loaded.tools).toEqual({});
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0].error).toBeTruthy();
    if (expectedError) expect(loaded.entries[0].error).toContain(expectedError);
  });

  // One bad file must not take the others down — that is the whole point of per-file isolation.
  it('isolates a failing plugin from the working ones', async () => {
    await writePlugin('a-broken.js', `export default () => { throw new Error('boom at load'); };`);
    await writePlugin('b-fine.js', specSource('survivor'));

    const loaded = await loadToolPlugins(host, BUILTINS);
    expect(Object.keys(loaded.tools)).toEqual(['survivor']);
    expect(loaded.entries[0].error).toContain('boom at load');
    expect(loaded.entries[1].error).toBeUndefined();
  });
});

describe('loadToolPlugins — triggers', () => {
  it('normalizes triggers for the matcher but reports them as authored', async () => {
    await writePlugin('t.js', specSource('withTriggers', `triggers: ['  Upgrade  ', '升级'],`));
    const loaded = await loadToolPlugins(host, BUILTINS);

    // Normalized once here so the disclosure matcher stays a plain substring check.
    expect(loaded.triggers.get('withTriggers')).toEqual(['upgrade', '升级']);
    // /v1/tools shows what the author wrote — hot reload without that is undebuggable.
    expect(loaded.entries[0].triggers).toEqual(['  Upgrade  ', '升级']);
  });

  // Absence from this map is what makes a plugin always-visible under progressive disclosure.
  it('leaves a plugin without triggers out of the map entirely', async () => {
    await writePlugin('t.js', specSource('noTriggers'));
    const loaded = await loadToolPlugins(host, BUILTINS);

    expect(loaded.triggers.has('noTriggers')).toBe(false);
    expect(loaded.entries[0].triggers).toBeUndefined();
  });
});

describe('loadToolPlugins — execution', () => {
  it('wraps the spec so the model can call it', async () => {
    await writePlugin('good.js', specSource('myTool'));
    const loaded = await loadToolPlugins(host, BUILTINS);

    await expect(loaded.tools.myTool.execute!({ q: 'g36' }, {} as never)).resolves.toEqual({
      echoed: 'g36',
    });
  });

  /**
   * The wrapper deliberately has no try/catch: `instrumentTools` owns the failure envelope, and
   * catching here would look like success to it — the error would lose its recovery hint.
   */
  it('lets an execute-time throw escape to the runtime envelope', async () => {
    await writePlugin(
      'thrower.js',
      `export default () => [{
        name: 'thrower', description: 'd', inputSchema: {},
        execute: () => { throw new Error('execute exploded'); },
      }];`,
    );
    const loaded = await loadToolPlugins(host, BUILTINS);

    await expect(async () => {
      await loaded.tools.thrower.execute!({}, {} as never);
    }).rejects.toThrow('execute exploded');
  });
});
