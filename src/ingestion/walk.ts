import * as fs from 'fs/promises';
import * as path from 'path';

export interface WalkOptions {
  /** Lowercased directory basenames to skip. Pruned before descending, not filtered after. */
  excludeDirs?: ReadonlySet<string>;
  /** Keep a file only when this returns true. Receives the basename. */
  keepFile?: (name: string) => boolean;
}

/**
 * Recursively collect file paths under `root`, **following symbolic links**.
 *
 * `fs.readdir(dir, { recursive: true })` cannot be used here: it reports symlinks as
 * neither file nor directory (`Dirent.isFile()` and `isDirectory()` are both false) and
 * never descends into a symlinked directory. A `DATA_DIR` assembled out of links into a
 * steamcmd download — the whole point of not duplicating gigabytes of game data — would
 * silently index as zero documents.
 *
 * Returned paths are **lexical**, not resolved. `readSource` guards against traversal
 * with a lexical `dataRoot` prefix check, so handing it a realpath that points outside
 * the data root would make every linked file unreadable. `fs.readFile` follows the link
 * on its own.
 */
export async function walkFiles(root: string, opts: WalkOptions = {}): Promise<string[]> {
  const { excludeDirs, keepFile } = opts;
  const files: string[] = [];
  // Realpaths of the root plus every directory reached *through* a symlink. A cycle has
  // to cross a link on every lap, so guarding those hops is enough to terminate — and
  // seeding the root is what stops a self-link (`pkg/x -> pkg`) from walking the whole
  // package a second time under a different lexical prefix.
  const seen = new Set<string>();

  async function walk(dir: string, guard: boolean): Promise<void> {
    if (guard) {
      const real = await fs.realpath(dir).catch(() => null);
      if (!real || seen.has(real)) return;
      seen.add(real);
    }

    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const isLink = entry.isSymbolicLink();

      let isDir: boolean;
      let isFile: boolean;
      if (isLink) {
        // stat() follows the link; a dangling one throws and is skipped.
        const st = await fs.stat(full).catch(() => null);
        if (!st) continue;
        isDir = st.isDirectory();
        isFile = st.isFile();
      } else {
        isDir = entry.isDirectory();
        isFile = entry.isFile();
      }

      if (isDir) {
        if (excludeDirs?.has(entry.name.toLowerCase())) continue;
        await walk(full, isLink);
        continue;
      }
      if (isFile && (!keepFile || keepFile(entry.name))) files.push(full);
    }
  }

  await walk(root, true);
  return files;
}
