import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Dirent } from 'fs';
import { walkFiles } from './walk.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: false,
  trimValues: true,
  alwaysCreateTextNode: false,
});

export type TranslationMap = Record<string, string>;

export interface LanguageData {
  language: string;
  translations: TranslationMap;
}

/** Narrow an XML node to an indexable object, or undefined if it is a leaf. */
function asNode(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** fast-xml-parser types `parse()` as `any`; narrow it once at the boundary. */
function parseXml(content: string): Record<string, unknown> {
  const parsed: unknown = parser.parse(content);
  return asNode(parsed) ?? {};
}

function extractTextsFromParsed(parsed: unknown, translations: TranslationMap): void {
  if (typeof parsed !== 'object' || parsed === null) return;
  const obj = parsed as Record<string, unknown>;

  for (const [rootKey, rootVal] of Object.entries(obj)) {
    if (rootKey === '#text' || rootKey.startsWith('@_')) continue;

    const textNodes = findTextNodes(rootVal);
    for (const t of textNodes) {
      // parseAttributeValue is off, so both attributes arrive as strings.
      const key = t['@_key'];
      const text = t['@_text'];
      if (typeof key === 'string' && key && typeof text === 'string') {
        translations[key] = text;
      }
    }
  }
}

function findTextNodes(val: unknown): Record<string, unknown>[] {
  if (val === null || val === undefined) return [];
  if (Array.isArray(val)) {
    return val.flatMap((v) => findTextNodes(v));
  }
  if (typeof val === 'object' && val !== null) {
    const obj = val as Record<string, unknown>;
    if (obj['@_key'] !== undefined && obj['@_text'] !== undefined) {
      return [obj];
    }
    for (const key of Object.keys(obj)) {
      if (key === '@_key' || key === '@_text') continue;
      const nested = findTextNodes(obj[key]);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

async function collectTranslationFiles(dir: string): Promise<string[]> {
  return walkFiles(dir, { keepFile: (name) => name.toLowerCase().endsWith('.xml') });
}

async function loadTranslationFile(filePath: string, translations: TranslationMap): Promise<void> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = parseXml(content);

  const fileRefs: string[] = [];
  const translationNodes = asNode(parsed['translations'])?.['translation'];
  if (translationNodes) {
    const refs = Array.isArray(translationNodes) ? translationNodes : [translationNodes];
    for (const ref of refs) {
      const refFile = asNode(ref)?.['@_file'];
      if (typeof refFile === 'string' && refFile) {
        fileRefs.push(refFile);
      }
    }
  }

  if (fileRefs.length > 0) {
    const baseDir = path.dirname(filePath);
    for (const ref of fileRefs) {
      const refPath = path.resolve(baseDir, ref);
      try {
        await loadTranslationFile(refPath, translations);
      } catch {
        // skip missing referenced files
      }
    }
    return;
  }

  extractTextsFromParsed(parsed, translations);
}

export async function loadLanguageData(languagesDir: string, language: string): Promise<LanguageData> {
  const langDir = path.join(languagesDir, language);
  const translations: TranslationMap = {};

  try {
    const files = await collectTranslationFiles(langDir);
    for (const file of files) {
      await loadTranslationFile(file, translations);
    }
  } catch {
    // language directory may not exist
  }

  return { language, translations };
}

export async function loadAllLanguages(languagesDir: string): Promise<LanguageData[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(languagesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const languages: LanguageData[] = [];
  for (const entry of entries) {
    // A symlinked `languages/<lang>` reports isDirectory() === false; stat() follows it.
    const isDir = entry.isSymbolicLink()
      ? ((await fs.stat(path.join(languagesDir, entry.name)).catch(() => null))?.isDirectory() ??
        false)
      : entry.isDirectory();
    if (!isDir) continue;

    const langData = await loadLanguageData(languagesDir, entry.name);
    if (Object.keys(langData.translations).length > 0) {
      languages.push(langData);
    }
  }

  return languages;
}

export function resolveI18n(
  doc: { type: string; key: string; data: unknown; flat_attributes: Record<string, unknown> },
  languages: LanguageData[],
): Record<string, Record<string, string>> | undefined {
  if (languages.length === 0) return undefined;

  const nameKeys = extractNameKeys(doc);
  if (nameKeys.length === 0) return undefined;

  const result: Record<string, Record<string, string>> = {};

  for (const lang of languages) {
    const resolved: Record<string, string> = {};
    for (const nk of nameKeys) {
      const translated = lang.translations[nk];
      if (translated !== undefined) {
        resolved[nk] = translated;
      }
    }
    if (Object.keys(resolved).length > 0) {
      result[lang.language] = resolved;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function extractNameKeys(
  doc: { type: string; key: string; data: unknown; flat_attributes: Record<string, unknown> },
): string[] {
  const keys: string[] = [];
  const attrs = doc.flat_attributes;

  const specName = attrs['specification.name'] ?? attrs['name'];
  if (typeof specName === 'string' && specName) {
    keys.push(specName);
  }

  if (doc.type === 'call') {
    const initiationComment = attrs['initiation_comment1'] ?? attrs['initiation_comment'];
    if (typeof initiationComment === 'string' && initiationComment) {
      keys.push(initiationComment);
    }
  }

  if (specName && typeof specName === 'string') {
    const parts = specName.split('-');
    if (parts.length > 1) {
      keys.push(parts[0]);
    }
  }

  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  return uniqueKeys;
}

export function getLocalizedName(
  doc: { type: string; key: string; data: unknown; flat_attributes: Record<string, unknown>; i18n?: Record<string, Record<string, string>> },
  language: string,
): string | undefined {
  if (!doc.i18n?.[language]) return undefined;
  const translations = doc.i18n[language];
  const nameKeys = extractNameKeys(doc);
  for (const nk of nameKeys) {
    if (translations[nk]) return translations[nk];
  }
  return undefined;
}