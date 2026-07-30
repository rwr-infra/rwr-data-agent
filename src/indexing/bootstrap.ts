import * as fs from 'fs/promises';
import { config } from '../config/index.js';
import { buildIndexes } from './build.js';
import {
  configureSearch,
  readIndexMeta,
  computeDataFingerprint,
  warmSearchIndex,
  INDEX_VERSION,
  type IndexMeta,
} from '../retrieval/localSearch.js';

export interface IndexStatus {
  ready: boolean;
  rebuilt: boolean;
  reason?: string;
  meta?: IndexMeta;
}

let status: IndexStatus = { ready: false, rebuilt: false };

export function getIndexStatus(): IndexStatus {
  return status;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Why the on-disk index cannot be used as-is, or null if it is current. */
async function staleReason(meta: IndexMeta | null): Promise<string | null> {
  if (!meta) return 'index missing';
  if (meta.version !== INDEX_VERSION) return `index version ${meta.version} != ${INDEX_VERSION}`;
  if (meta.data_dir !== config.dataDir) return `index was built from ${meta.data_dir}`;

  try {
    const fp = await computeDataFingerprint(config.dataDir);
    if (fp.files !== meta.fingerprint.files) {
      return `file count changed (${meta.fingerprint.files} -> ${fp.files})`;
    }
    if (fp.maxMtimeMs > meta.fingerprint.maxMtimeMs) {
      return 'source files modified since the last build';
    }
  } catch (err) {
    // Data dir unreadable — keep whatever index we have rather than failing hard.
    console.warn(`[index] Staleness check skipped: ${(err as Error).message}`);
    return null;
  }

  return null;
}

/**
 * Make sure the search + graph indexes are present and current, building them from
 * `DATA_DIR` when they are not. Never throws: a failure degrades to a warning and the
 * first search reports the missing index through the normal error path.
 */
export async function ensureIndexes(): Promise<IndexStatus> {
  configureSearch(config.searchIndexPath);

  const meta = await readIndexMeta(config.searchIndexPath);

  let reason: string | null = null;
  if (config.autoBuildIndex) {
    if (!(await dirExists(config.dataDir))) {
      reason = null;
      if (!meta) {
        status = { ready: false, rebuilt: false, reason: `data directory not found: ${config.dataDir}` };
        console.warn(`[index] ${status.reason} — set DATA_DIR to your RWR data folder.`);
        return status;
      }
    } else {
      reason = await staleReason(meta);
    }
  } else if (!meta) {
    status = { ready: false, rebuilt: false, reason: 'index missing and AUTO_BUILD_INDEX=false' };
    console.warn('[index] No search index and auto-build is disabled. Run "npm run build:index".');
    return status;
  }

  let rebuilt = false;
  if (reason) {
    console.log(`[index] Rebuilding: ${reason}`);
    try {
      const start = Date.now();
      const result = await buildIndexes({
        dataDir: config.dataDir,
        graphPath: config.graphPath,
        searchIndexPath: config.searchIndexPath,
      });
      rebuilt = true;
      console.log(
        `[index] Built ${result.documents} documents from ${result.packages.length} package(s) in ${(
          (Date.now() - start) / 1000
        ).toFixed(1)}s: ${result.packages.map((p) => p.name).join(', ')}`,
      );
    } catch (err) {
      status = { ready: false, rebuilt: false, reason: `build failed: ${(err as Error).message}` };
      console.warn(`[index] ${status.reason}`);
      return status;
    }
  }

  try {
    const loaded = await warmSearchIndex();
    status = { ready: true, rebuilt, meta: loaded ?? undefined };
  } catch (err) {
    status = { ready: false, rebuilt, reason: (err as Error).message };
    console.warn(`[index] ${status.reason}`);
  }

  return status;
}
