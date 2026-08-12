import * as path from 'path';
import { parseXml, parseXmlTree } from './xmlParser.js';
import { parseAngelScriptContent } from './asParser.js';
import { walkFiles } from './walk.js';
import type { StructuredDocument } from '../types/index.js';

/** Extensions parsed as XML — everything here goes through `parseXmlTree`. */
export const XML_EXTS = new Set([
  '.xml',
  '.call',
  '.character',
  '.weapon',
  '.projectile',
  '.carry_item',
  '.base_weapon',
  '.animation_base',
  '.base',
  '.base_carry_item',
]);
/** Extensions indexed as opaque text: one document each, no structure extracted. */
export const PLAIN_TEXT_EXTS = new Set(['.ai', '.resources', '.models', '.name', '.text_lines']);

export const SUPPORTED_EXTS = new Set([...XML_EXTS, ...PLAIN_TEXT_EXTS, '.as']);
export const EXCLUDED_DIRS = new Set(['models', 'maps']);

export async function collectFiles(dir: string): Promise<string[]> {
  return walkFiles(dir, {
    excludeDirs: EXCLUDED_DIRS,
    keepFile: (name) => SUPPORTED_EXTS.has(path.extname(name).toLowerCase()),
  });
}

/**
 * Turn one already-read file into its search documents, dispatching on extension.
 *
 * Content-in rather than path-in on purpose: the index build reads and XML-parses each file
 * exactly once and derives both the entity graph and the search documents from that single
 * result, so it passes `tree` straight through. `tree` is optional only for callers that have
 * content but no parse — pass it whenever you have it, or the file is parsed twice.
 */
export async function parseContent(
  content: string,
  filePath: string,
  modName: string,
  tree?: Record<string, unknown>,
): Promise<StructuredDocument[]> {
  const ext = path.extname(filePath).toLowerCase();
  if (XML_EXTS.has(ext)) {
    return parseXmlTree(tree ?? parseXml(content), filePath, modName);
  }
  if (ext === '.as') {
    return parseAngelScriptContent(content, filePath, modName);
  }
  if (PLAIN_TEXT_EXTS.has(ext)) {
    return [plainTextDoc(content, filePath, modName)];
  }
  return [];
}

function plainTextDoc(content: string, filePath: string, modName: string): StructuredDocument {
  const base = path.basename(filePath);
  const ext = path.extname(filePath).slice(1);
  return {
    type: 'script_chunk',
    key: base,
    label: 'PlainText',
    source_file: filePath,
    mod_name: modName,
    description: `File: ${base} (type: ${ext})`,
    raw_text: content,
    data: { content, file_type: ext },
    flat_attributes: { file: base, type: ext },
    metadata: { source_type: ext },
  };
}
