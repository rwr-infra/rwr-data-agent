import * as fs from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { dynamicTool, jsonSchema, type Tool } from 'ai';

/**
 * Runtime tool plugins: plain ESM files an operator drops into a directory, each exporting a
 * factory that returns tool specs.
 *
 * ⚠️ **Trust model.** Plugins are `import()`ed into this process and run with its full privileges —
 * filesystem, network, `process.env`. This is an *operator drops a file* model, the same as
 * `require`-ing an npm package. It is **not** a sandbox: never wire this to untrusted uploads.
 *
 * And do not mistake the `host` object for a boundary. It exists so a plugin never has to reach
 * into internal modules; it cannot stop one from doing `import('node:fs')` on its own. Real
 * isolation in Node needs a subprocess or a container — the permission model is process-wide and
 * `worker_threads` do not get their own.
 *
 * The host is a type parameter because its shape is entirely the domain's business. This module
 * only ever hands it to the factory.
 */

export interface PluginToolSpec {
  /** Tool name exposed to the model. Must be a valid identifier, and may not shadow a built-in. */
  name: string;
  description: string;
  /** JSON Schema — so a plugin file carries no dependency on the host's zod version. */
  inputSchema: Record<string, unknown>;
  /**
   * Optional relevance keywords, matched case-insensitively as a substring of the user's query.
   * Under progressive tool disclosure the first step only exposes a tool whose triggers hit.
   *
   * Declaring this is an **author opt-in to being hidden**. A plugin without it is never hidden —
   * the alternative would make every existing plugin vanish the moment the registry grew.
   */
  triggers?: string[];
  /** May return a promise; `unknown` already covers that. */
  execute: (input: never) => unknown;
}

export type PluginFactory<HOST> = (host: HOST) => PluginToolSpec[] | Promise<PluginToolSpec[]>;

/** What an inventory endpoint reports per discovered plugin — including the ones that failed. */
export interface PluginEntry {
  name: string;
  file: string;
  description?: string;
  /** As the author declared them, not normalized: an inventory nobody can debug is worth little. */
  triggers?: string[];
  loadedAt: string;
  error?: string;
}

export interface LoadedPlugins {
  tools: Record<string, Tool>;
  entries: PluginEntry[];
  /** Tool name → normalized (trimmed, lowercased) triggers, for the tools that declared any. */
  triggers: Map<string, string[]>;
}

export interface LoadPluginsOptions<HOST> {
  /** Directory to scan. A missing directory means "no plugins", not an error. */
  dir: string;
  /** Handed to each factory untouched. */
  host: HOST;
  /** Built-in tool names a plugin may not shadow. */
  reservedNames: Iterable<string>;
}

const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function validateSpec(spec: unknown, file: string): PluginToolSpec {
  if (typeof spec !== 'object' || spec === null) {
    throw new Error(`${file}: tool spec must be an object`);
  }
  const s = spec as Partial<PluginToolSpec>;
  if (typeof s.name !== 'string' || !TOOL_NAME.test(s.name)) {
    throw new Error(`${file}: invalid tool name ${JSON.stringify(s.name)}`);
  }
  if (typeof s.description !== 'string' || !s.description.trim()) {
    throw new Error(`${file}: tool "${s.name}" needs a non-empty description`);
  }
  if (typeof s.inputSchema !== 'object' || s.inputSchema === null) {
    throw new Error(`${file}: tool "${s.name}" needs a JSON Schema inputSchema`);
  }
  if (s.triggers !== undefined) {
    if (
      !Array.isArray(s.triggers) ||
      s.triggers.length === 0 ||
      !s.triggers.every((t) => typeof t === 'string' && t.trim().length > 0)
    ) {
      throw new Error(
        `${file}: tool "${s.name}" needs triggers as a non-empty array of non-empty strings ` +
          `(omit the field to keep the tool always visible)`,
      );
    }
  }
  if (typeof s.execute !== 'function') {
    throw new Error(`${file}: tool "${s.name}" needs an execute function`);
  }
  return s as PluginToolSpec;
}

function toTool(spec: PluginToolSpec): Tool {
  return dynamicTool({
    description: spec.description,
    inputSchema: jsonSchema(spec.inputSchema),
    // No try/catch here on purpose: the execution envelope owns the failure contract, and catching
    // at this layer would look like success to it — the error would lose its recovery hint.
    execute: (input) => spec.execute(input as never),
  });
}

/**
 * Load every plugin under `dir`.
 *
 * **Failure is per file.** A module that will not import, a factory that throws, a spec that fails
 * validation — each is logged, recorded on its entry, and skipped. One bad file never takes the
 * others down, which is the property that makes a plugin directory safe to hand to someone else.
 */
export async function loadToolPlugins<HOST>({
  dir,
  host,
  reservedNames,
}: LoadPluginsOptions<HOST>): Promise<LoadedPlugins> {
  const tools: Record<string, Tool> = {};
  const entries: PluginEntry[] = [];
  const triggers = new Map<string, string[]>();
  const reserved = new Set(reservedNames);

  let files: string[];
  try {
    files = (await fs.readdir(dir))
      .filter(
        (f) =>
          (f.endsWith('.js') || f.endsWith('.mjs')) && !f.startsWith('_') && !f.startsWith('.'),
      )
      .sort();
  } catch {
    return { tools, entries, triggers }; // no plugin directory — plugins are optional
  }

  for (const file of files) {
    const abs = path.join(dir, file);
    const loadedAt = new Date().toISOString();
    try {
      const { mtimeMs } = await fs.stat(abs);
      // The ESM module cache cannot be purged, so a changing query string is what makes hot reload
      // possible at all. Each reload leaks the previous module — acceptable only because hot reload
      // is a development setting.
      const mod = (await import(`${pathToFileURL(abs).href}?v=${mtimeMs}`)) as {
        default?: unknown;
      };

      if (typeof mod.default !== 'function') {
        throw new Error('default export must be a function (host) => tool specs');
      }
      const produced = await (mod.default as PluginFactory<HOST>)(host);
      const specs = Array.isArray(produced) ? produced : [produced];

      for (const raw of specs) {
        const spec = validateSpec(raw, file);
        if (reserved.has(spec.name)) {
          entries.push({
            name: spec.name,
            file,
            loadedAt,
            error: `name collides with a built-in tool — plugin definition ignored`,
          });
          continue;
        }
        if (tools[spec.name]) {
          entries.push({ name: spec.name, file, loadedAt, error: 'duplicate tool name — ignored' });
          continue;
        }
        tools[spec.name] = toTool(spec);
        const entry: PluginEntry = {
          name: spec.name,
          file,
          description: spec.description,
          loadedAt,
        };
        if (spec.triggers) {
          entry.triggers = spec.triggers;
          // Normalized once here so the disclosure matcher stays a plain substring check.
          triggers.set(
            spec.name,
            spec.triggers.map((t) => t.trim().toLowerCase()),
          );
        }
        entries.push(entry);
      }
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`[plugin] Failed to load ${file}: ${message}`);
      entries.push({
        name: path.basename(file, path.extname(file)),
        file,
        loadedAt,
        error: message,
      });
    }
  }

  return { tools, entries, triggers };
}
