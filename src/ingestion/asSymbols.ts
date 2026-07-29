import type { ScriptSymbol } from '../agent/types.js';

/**
 * AngelScript symbol extraction.
 *
 * Deliberately not a parser: a line/brace scanner over comment- and string-blanked
 * source. It resolves the cases that actually cost recall — multi-line signatures,
 * default-valued parameters, class members, enums/namespaces/funcdefs — without
 * taking on a grammar dependency. See the plan notes on tree-sitter: swapping in a
 * real parser means replacing this one function, nothing else.
 */

const CONTROL_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'return',
  'else',
  'do',
  'catch',
  'case',
  'break',
  'continue',
  'new',
  'delete',
  'throw',
]);

/** Type-ish token: `void`, `array<string>`, `Foo@`, `const string&in`, `Ns::Type`. */
const TYPE = String.raw`[A-Za-z_][\w:]*\s*(?:<[^<>]*(?:<[^<>]*>)?[^<>]*>)?\s*(?:@|&(?:in|out|inout)?)?(?:\s*\[\s*\])?`;

const RE_INCLUDE = /^\s*#include\s+["<]([^">]+)[">]/;
const RE_CONTAINER = /^\s*(?:(?:shared|abstract|final|external)\s+)*(class|interface|mixin)\s+([A-Za-z_]\w*)/;
const RE_NAMESPACE = /^\s*namespace\s+([A-Za-z_][\w:]*)/;
const RE_ENUM = /^\s*(?:shared\s+)?enum\s+([A-Za-z_]\w*)/;
const RE_FUNCDEF = new RegExp(String.raw`^\s*(?:shared\s+)?funcdef\s+${TYPE}\s+([A-Za-z_]\w*)\s*\(`);
const RE_FUNCTION = new RegExp(
  String.raw`^\s*(?:(?:private|protected|shared|abstract|final|external|override|explicit)\s+)*` +
    String.raw`(?:const\s+)?(${TYPE})\s+([A-Za-z_]\w*)\s*\(([\s\S]*)\)\s*` +
    String.raw`(?:const\b|override\b|final\b|property\b|delete\b|\s)*\s*(?:\{|;|$)`,
);
/** Constructor / destructor — no return type, only valid inside a class body. */
const RE_CTOR = /^\s*(~?)([A-Za-z_]\w*)\s*\(([\s\S]*)\)\s*(?:\{|;|$)/;
const RE_PROPERTY = new RegExp(
  String.raw`^\s*(?:(?:private|protected|const)\s+)*(${TYPE})\s+([A-Za-z_]\w*)\s*(?:=[^;]*)?;\s*$`,
);

/**
 * Replace comment and string-literal bodies with spaces, preserving every newline and
 * the original character offsets. Keeps brace counting and keyword matching honest.
 */
function blankCommentsAndStrings(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      out[i++] = ' ';
      out[i++] = ' ';
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) {
        out[i++] = ' ';
        out[i++] = ' ';
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      // Heredoc form: """ ... """
      const heredoc = quote === '"' && next === '"' && src[i + 2] === '"';
      out[i++] = ' ';
      if (heredoc) {
        out[i++] = ' ';
        out[i++] = ' ';
        while (i < n && !(src[i] === '"' && src[i + 1] === '"' && src[i + 2] === '"')) {
          if (src[i] !== '\n') out[i] = ' ';
          i++;
        }
        for (let k = 0; k < 3 && i < n; k++) out[i++] = ' ';
        continue;
      }
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          out[i++] = ' ';
          if (i < n && src[i] !== '\n') out[i++] = ' ';
          continue;
        }
        if (src[i] === '\n') break; // unterminated literal — don't swallow the file
        out[i++] = ' ';
      }
      if (i < n && src[i] === quote) out[i++] = ' ';
      continue;
    }
    i++;
  }

  return out.join('');
}

function countUnbalanced(text: string, open: string, close: string): number {
  let d = 0;
  for (const ch of text) {
    if (ch === open) d++;
    else if (ch === close) d--;
  }
  return d;
}

/** True when `=` appears before the first `(` — an assignment, not a declaration. */
function isAssignment(line: string): boolean {
  const paren = line.indexOf('(');
  const eq = line.search(/[^=!<>]=[^=]/);
  return eq !== -1 && (paren === -1 || eq < paren);
}

function firstWord(line: string): string {
  return line.trim().split(/[^\w]/, 1)[0] ?? '';
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

interface Container {
  name: string;
  /** Brace depth of the body — the container pops when depth falls back below this. */
  depth: number;
}

export function extractScriptSymbols(source: string, fileBase: string): ScriptSymbol[] {
  const symbols: ScriptSymbol[] = [];
  const rawLines = source.split('\n');
  const blankLines = blankCommentsAndStrings(source).split('\n');

  const stack: Container[] = [];
  let depth = 0;
  let pendingContainer: string | null = null;

  const parentOf = (): string | undefined => stack[stack.length - 1]?.name;

  for (let i = 0; i < rawLines.length; i++) {
    // #include is read from the raw line — blanking would have eaten the path.
    const inc = rawLines[i].match(RE_INCLUDE);
    if (inc) {
      symbols.push({
        file: fileBase,
        name: inc[1],
        signature: `#include "${inc[1]}"`,
        kind: 'include',
        line: i + 1,
      });
      continue;
    }
    if (rawLines[i].trimStart().startsWith('#')) continue; // other preprocessor directives

    // Join continuation lines until parentheses balance, so multi-line signatures match.
    let logical = blankLines[i];
    let rawLogical = rawLines[i];
    let end = i;
    let open = countUnbalanced(logical, '(', ')');
    while (open > 0 && end + 1 < rawLines.length && end - i < 20) {
      end++;
      logical += ' ' + blankLines[end];
      rawLogical += ' ' + rawLines[end];
      open += countUnbalanced(blankLines[end], '(', ')');
    }
    const startLine = i + 1;
    const kw = firstWord(logical);
    const signature = collapse(rawLogical).replace(/\s*\{\s*$/, '');


    if (!CONTROL_KEYWORDS.has(kw)) {
      const container = logical.match(RE_CONTAINER);
      const ns = logical.match(RE_NAMESPACE);
      const en = logical.match(RE_ENUM);
      const fd = logical.match(RE_FUNCDEF);

      if (container) {
        symbols.push({
          file: fileBase,
          name: container[2],
          signature,
          kind: 'class',
          line: startLine,
          ...(parentOf() ? { parent: parentOf() } : {}),
        });
        pendingContainer = container[2];
      } else if (ns) {
        symbols.push({ file: fileBase, name: ns[1], signature, kind: 'namespace', line: startLine });
        pendingContainer = ns[1];
      } else if (en) {
        symbols.push({
          file: fileBase,
          name: en[1],
          signature,
          kind: 'enum',
          line: startLine,
          ...(parentOf() ? { parent: parentOf() } : {}),
        });
      } else if (fd) {
        symbols.push({ file: fileBase, name: fd[1], signature, kind: 'funcdef', line: startLine });
      } else {
        const enclosing = parentOf();
        // An initialised member (`int m_count = 0;`) is an assignment *and* a
        // declaration, so the assignment guard only gates the callable forms.
        const declaration = !isAssignment(logical);
        const fn = declaration ? logical.match(RE_FUNCTION) : null;
        const ctor = declaration && enclosing ? logical.match(RE_CTOR) : null;

        if (fn && !CONTROL_KEYWORDS.has(fn[2])) {
          symbols.push({
            file: fileBase,
            name: fn[2],
            signature,
            kind: 'function',
            line: startLine,
            ...(enclosing ? { parent: enclosing } : {}),
          });
        } else if (ctor && ctor[2] === enclosing) {
          symbols.push({
            file: fileBase,
            name: `${ctor[1]}${ctor[2]}`,
            signature,
            kind: 'function',
            line: startLine,
            parent: enclosing,
          });
        } else if (enclosing && depth === (stack[stack.length - 1]?.depth ?? -1)) {
          const prop = logical.match(RE_PROPERTY);
          if (prop && !CONTROL_KEYWORDS.has(prop[1].trim())) {
            symbols.push({
              file: fileBase,
              name: prop[2],
              signature,
              kind: 'property',
              line: startLine,
              parent: enclosing,
            });
          }
        }
      }
    }

    // Track brace depth across every line we consumed for this logical line.
    for (let j = i; j <= end; j++) {
      for (const ch of blankLines[j]) {
        if (ch === '{') {
          depth++;
          if (pendingContainer) {
            stack.push({ name: pendingContainer, depth });
            pendingContainer = null;
          }
        } else if (ch === '}') {
          if (stack.length > 0 && stack[stack.length - 1].depth === depth) stack.pop();
          depth--;
        }
      }
    }
    // A container's `{` may sit on the next line, so `pendingContainer` survives across
    // lines — unless this was a forward declaration (`class Foo;`), which never opens one.
    if (pendingContainer && /;\s*$/.test(logical)) pendingContainer = null;

    i = end;
  }

  return symbols;
}

/** Group symbol names by kind — used to build the searchable summary of a script file. */
export function summarizeSymbols(symbols: ScriptSymbol[]) {
  const pick = (kind: ScriptSymbol['kind']) => symbols.filter((s) => s.kind === kind).map((s) => s.name);
  const dedupe = (xs: string[]) => [...new Set(xs)];
  return {
    includes: dedupe(pick('include')),
    classes: dedupe(pick('class')),
    functions: dedupe(pick('function')),
    enums: dedupe(pick('enum')),
    namespaces: dedupe(pick('namespace')),
    funcdefs: dedupe(pick('funcdef')),
    properties: dedupe(pick('property')),
  };
}
