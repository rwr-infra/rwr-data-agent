import * as fs from 'fs/promises';
import * as path from 'path';
import { parseXmlFile } from './xmlParser.js';
import { parseAngelScriptFile } from './asParser.js';
import type { StructuredDocument } from '../types/index.js';

export const SUPPORTED_EXTS = new Set(['.xml', '.as', '.call', '.character', '.ai', '.resources', '.models', '.name', '.text_lines', '.weapon', '.projectile', '.carry_item', '.base_weapon', '.animation_base', '.base', '.base_carry_item']);
export const EXCLUDED_DIRS = new Set(['models', 'maps']);

export async function collectFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const fullPath = path.join(entry.parentPath ?? dir, entry.name);
    const relativePath = path.relative(dir, fullPath);
    const pathParts = relativePath.split(path.sep);

    if (pathParts.some((part) => EXCLUDED_DIRS.has(part.toLowerCase()))) {
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (SUPPORTED_EXTS.has(ext)) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function parseFile(filePath: string, modName: string): Promise<StructuredDocument[]> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xml' || ext === '.call' || ext === '.character' || ext === '.weapon' || ext === '.projectile' || ext === '.carry_item' || ext === '.base_weapon' || ext === '.animation_base' || ext === '.base' || ext === '.base_carry_item') {
    return parseXmlFile(filePath, modName);
  }
  if (ext === '.as') {
    return parseAngelScriptFile(filePath, modName);
  }
  if (['.ai', '.resources', '.models', '.name', '.text_lines'].includes(ext)) {
    return parsePlainTextFile(filePath, modName);
  }
  return [];
}

export async function parsePlainTextFile(filePath: string, modName: string): Promise<StructuredDocument[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const base = path.basename(filePath);
  const ext = path.extname(filePath).slice(1);
  return [{
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
  }];
}