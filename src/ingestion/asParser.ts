import * as fs from 'fs/promises';
import * as path from 'path';
import { extractScriptSymbols, summarizeSymbols } from './asSymbols.js';
import type { StructuredDocument } from '../types/index.js';

/**
 * AngelScript files become one `script_chunk` document each.
 *
 * `structuredDocToRWRDocument` only puts the first 500 chars of `raw_text` into the
 * searchable content, so a long script would otherwise be almost invisible to
 * full-text search. The symbol summary goes into `description` + `flat_attributes`
 * instead — both of which are rendered into the content in full — which is what makes
 * "which script defines OnPlayerSpawn" and "what includes gamemode_campaign.as"
 * answerable without the model first guessing the file name.
 */

/** Cap per attribute so one huge script cannot dominate the index. */
const MAX_NAMES = 120;

function joinNames(names: string[]): string | undefined {
  if (names.length === 0) return undefined;
  const shown = names.slice(0, MAX_NAMES);
  const suffix = names.length > MAX_NAMES ? `, …+${names.length - MAX_NAMES} more` : '';
  return shown.join(', ') + suffix;
}

function describe(base: string, s: ReturnType<typeof summarizeSymbols>): string {
  const parts = [`AngelScript file: ${base}.`];
  if (s.classes.length) parts.push(`Defines ${s.classes.length === 1 ? 'class' : 'classes'} ${s.classes.join(', ')}.`);
  if (s.namespaces.length) parts.push(`Namespaces: ${s.namespaces.join(', ')}.`);
  if (s.functions.length) parts.push(`${s.functions.length} function${s.functions.length === 1 ? '' : 's'}.`);
  if (s.includes.length) parts.push(`Includes ${s.includes.length} file${s.includes.length === 1 ? '' : 's'}.`);
  return parts.join(' ');
}

export async function parseAngelScriptFile(filePath: string, modName: string): Promise<StructuredDocument[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const base = path.basename(filePath, '.as');
  const symbols = extractScriptSymbols(content, path.basename(filePath));
  const summary = summarizeSymbols(symbols);

  const flat: Record<string, unknown> = { file: base };
  const attrs: [string, string[]][] = [
    ['classes', summary.classes],
    ['namespaces', summary.namespaces],
    ['functions', summary.functions],
    ['includes', summary.includes],
    ['enums', summary.enums],
    ['funcdefs', summary.funcdefs],
    ['properties', summary.properties],
  ];
  for (const [key, names] of attrs) {
    const joined = joinNames(names);
    if (joined) flat[key] = joined;
  }

  return [
    {
      type: 'script_chunk' as const,
      key: base,
      label: 'AngelScript',
      source_file: filePath,
      mod_name: modName,
      description: describe(base, summary),
      raw_text: content,
      data: { content, symbols },
      flat_attributes: flat,
      metadata: {
        symbol_count: symbols.length,
        classes: summary.classes,
        functions: summary.functions,
        includes: summary.includes,
      },
    },
  ];
}
