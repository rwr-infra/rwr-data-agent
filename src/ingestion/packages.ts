import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs/promises';
import * as path from 'path';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

export const PACKAGE_MARKER = 'package_config.xml';

export interface DataPackage {
  /** Directory basename — the stable key used as `mod_name` on every document. */
  name: string;
  /** Human-readable name from <package name="…">, falls back to `name`. */
  displayName: string;
  /** Absolute path to the package directory. */
  dir: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Read the <package name="…"> attribute. RWR packages may ship an empty `<package />`. */
async function readDisplayName(dir: string, fallback: string): Promise<string> {
  try {
    const xml = await fs.readFile(path.join(dir, PACKAGE_MARKER), 'utf-8');
    const parsed = parser.parse(xml) as Record<string, unknown>;
    const pkg = parsed.package as Record<string, unknown> | undefined;
    const name = pkg?.['@_name'];
    if (typeof name === 'string' && name.trim()) return name.trim();
  } catch {
    // malformed or unreadable package_config.xml — fall back to the directory name
  }
  return fallback;
}

async function toPackage(dir: string): Promise<DataPackage> {
  const name = path.basename(dir);
  return { name, displayName: await readDisplayName(dir, name), dir };
}

/**
 * Discover RWR packages under a data root.
 *
 * Looks at the root itself and its immediate subdirectories only — deliberately not
 * recursive, because a package can contain its own `packages/<overlay>/` subtree
 * (e.g. ww2_base/packages/edelweiss) which belongs to the parent package, not a
 * standalone one.
 */
export async function discoverPackages(root: string): Promise<DataPackage[]> {
  const absRoot = path.resolve(root);

  if (await exists(path.join(absRoot, PACKAGE_MARKER))) {
    return [await toPackage(absRoot)];
  }

  let entries: string[];
  try {
    entries = await fs.readdir(absRoot);
  } catch {
    throw new Error(`Data directory not found: ${absRoot}`);
  }

  const found: DataPackage[] = [];
  for (const entry of entries.sort()) {
    const dir = path.join(absRoot, entry);
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    if (await exists(path.join(dir, PACKAGE_MARKER))) {
      found.push(await toPackage(dir));
    }
  }

  // No marker anywhere — treat the root as a single unnamed package so an arbitrary
  // folder of game files still indexes.
  if (found.length === 0) return [await toPackage(absRoot)];

  return found;
}
