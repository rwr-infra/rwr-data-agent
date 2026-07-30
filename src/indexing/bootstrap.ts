import * as fs from 'fs/promises';
import { config } from '../config/index.js';
import { buildIndexes } from './build.js';
import {
  configureSearch,
  readIndexMeta,
  computeDataFingerprint,
  warmSearchIndex,
  INDEX_VERSION,
  type IndexFingerprint,
  type IndexMeta,
} from '../retrieval/localSearch.js';

export interface IndexStatus {
  ready: boolean;
  rebuilt: boolean;
  /** A build is in progress. The server serves `/health` throughout; retrieval is unavailable. */
  building: boolean;
  reason?: string;
  meta?: IndexMeta;
}

let status: IndexStatus = { ready: false, rebuilt: false, building: false };
let inFlight: Promise<IndexStatus> | null = null;

export function getIndexStatus(): IndexStatus {
  return status;
}

/**
 * Kick off `ensureIndexes()` without waiting for it, and hand back the promise.
 *
 * A full rebuild is minutes of CPU on a small host. Awaiting it before `listen()` meant the
 * port stayed closed for that whole time: health probes failed and the process looked hung.
 * Now the server comes up immediately, `/health` reports `building`, and retrieval starts
 * answering as soon as the index is warm. Concurrent calls share the one in-flight build.
 */
export function startIndexes(): Promise<IndexStatus> {
  if (inFlight) return inFlight;
  status = { ...status, building: true };
  inFlight = ensureIndexes().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Resolve once the index is warm (or has failed). For callers that need a ready index rather
 * than a responsive port — the eval harness, scripts — where `startIndexes()`' whole point of
 * not blocking does not apply.
 */
export function whenIndexesReady(): Promise<IndexStatus> {
  return inFlight ?? Promise.resolve(status);
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** What the staleness probe learned — the walk it did is reusable by the build that follows. */
interface StaleCheck {
  reason: string | null;
  fingerprint?: IndexFingerprint;
  filesByPackage?: Map<string, string[]>;
}

/** Why the on-disk index cannot be used as-is, or null if it is current. */
async function staleReason(meta: IndexMeta | null): Promise<StaleCheck> {
  if (!meta) return { reason: 'index missing' };
  if (meta.version !== INDEX_VERSION) return { reason: `index version ${meta.version} != ${INDEX_VERSION}` };
  if (meta.data_dir !== config.dataDir) return { reason: `index was built from ${meta.data_dir}` };

  try {
    const { fingerprint, filesByPackage } = await computeDataFingerprint(config.dataDir);
    if (fingerprint.files !== meta.fingerprint.files) {
      return {
        reason: `file count changed (${meta.fingerprint.files} -> ${fingerprint.files})`,
        fingerprint,
        filesByPackage,
      };
    }
    if (fingerprint.maxMtimeMs > meta.fingerprint.maxMtimeMs) {
      return { reason: 'source files modified since the last build', fingerprint, filesByPackage };
    }
  } catch (err) {
    // Data dir unreadable — keep whatever index we have rather than failing hard.
    console.warn(`[index] Staleness check skipped: ${(err as Error).message}`);
    return { reason: null };
  }

  return { reason: null };
}

/**
 * Make sure the search + graph indexes are present and current, building them from
 * `DATA_DIR` when they are not. Never throws: a failure degrades to a warning and the
 * first search reports the missing index through the normal error path.
 */
export async function ensureIndexes(): Promise<IndexStatus> {
  configureSearch(config.searchIndexPath);

  const meta = await readIndexMeta(config.searchIndexPath);

  let check: StaleCheck = { reason: null };
  if (config.autoBuildIndex) {
    if (!(await dirExists(config.dataDir))) {
      if (!meta) {
        status = { ready: false, rebuilt: false, building: false, reason: `data directory not found: ${config.dataDir}` };
        console.warn(`[index] ${status.reason} — set DATA_DIR to your RWR data folder.`);
        return status;
      }
    } else {
      check = await staleReason(meta);
    }
  } else if (!meta) {
    status = { ready: false, rebuilt: false, building: false, reason: 'index missing and AUTO_BUILD_INDEX=false' };
    console.warn('[index] No search index and auto-build is disabled. Run "npm run build:index".');
    return status;
  }

  let rebuilt = false;
  if (check.reason) {
    console.log(`[index] Rebuilding: ${check.reason}`);
    try {
      const start = Date.now();
      const result = await buildIndexes({
        dataDir: config.dataDir,
        graphPath: config.graphPath,
        searchIndexPath: config.searchIndexPath,
        filesByPackage: check.filesByPackage,
        fingerprint: check.fingerprint,
      });
      rebuilt = true;
      console.log(
        `[index] Built ${result.documents} documents from ${result.packages.length} package(s) in ${(
          (Date.now() - start) / 1000
        ).toFixed(1)}s: ${result.packages.map((p) => p.name).join(', ')}`,
      );
    } catch (err) {
      status = { ready: false, rebuilt: false, building: false, reason: `build failed: ${(err as Error).message}` };
      console.warn(`[index] ${status.reason}`);
      return status;
    }
  }

  try {
    const loaded = await warmSearchIndex();
    status = { ready: true, rebuilt, building: false, meta: loaded ?? undefined };
  } catch (err) {
    status = { ready: false, rebuilt, building: false, reason: (err as Error).message };
    console.warn(`[index] ${status.reason}`);
  }

  return status;
}
