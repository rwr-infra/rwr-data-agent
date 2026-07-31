/**
 * Weapon skill-trait lookup for the GFL_Castling mod.
 *
 * Mod-specific, so it lives here rather than in the core tool set. See
 * types/tool-plugin.d.ts for the plugin contract and lookup-upgrade.js for the
 * reference implementation this mirrors.
 *
 * GFLskill.as is not a skill definition table — it is an effect dispatcher with no
 * names and no descriptions. A weapon's "技能特色" is only recoverable by joining six
 * sources, and no built-in tool can do that join: searchDocs sees one file at a time,
 * and the graph does not index projectile `instance_key` edges at all, which is exactly
 * where the damage and radius numbers live.
 *
 * Chain: weapon key → commandSkillIndex → /skill handler → projectile
 *        → notify_script key → gameSkillIndex → GFLskill case → spawned projectiles → blast numbers
 * Sources, all inside the package directory:
 *   1. scripts/core/command_skill_info.as  — weapon key → skill index (+ two pre-switch arrays)
 *   2. scripts/trackers/commandskill.as    — switch arm → handler body: cooldowns, projectiles
 *   3. scripts/core/gfl_skill_info.as      — script skill key → game skill index (+ Chinese label)
 *   4. scripts/trackers/GFLskill.as        — game skill index → effect body
 *   5. weapons/*.projectile                — notify_script links, blast damage, spawn chain
 *   6. weapons/*.weapon                    — weapon key → display name
 *   7. languages/cn/GFL_alltext.xml        — display name → Chinese name, and the -[trait] registry
 */

import * as fs from 'fs/promises';
import * as path from 'path';

const INDEX_VERSION = 1;

/** Projectile spawn chains fan out fast; these keep one answer readable. */
const CHAIN_MAX_DEPTH = 4;
const CHAIN_MAX_NODES = 20;
const HANDLER_EXCERPT_CHARS = 4000;
const EFFECT_EXCERPT_CHARS = 3000;

/** The flattened 13 MB copy of every weapon — reading it only duplicates the real files. */
const MERGED_WEAPON_FILE = 'merged_weapon.weapon';

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

/** Packages that ship GFL_alltext.xml — this tool is meaningless anywhere else. */
async function findCastlingRoots(dataDir) {
  const roots = [];
  const candidates = [dataDir];
  try {
    for (const entry of await fs.readdir(dataDir, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(dataDir, entry.name));
    }
  } catch {
    return roots;
  }
  for (const dir of candidates) {
    try {
      await fs.access(path.join(dir, 'languages', 'cn', 'GFL_alltext.xml'));
      roots.push(dir);
    } catch {
      /* not a Castling-style package */
    }
  }
  return roots;
}

/** Every source is independently optional — a missing one degrades the answer, not the tool. */
async function readIfExists(file) {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch {
    return undefined;
  }
}

function buildLineStarts(content) {
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') starts.push(i + 1);
  return starts;
}

/** 1-based line number for a character offset. */
function lineAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Offset just past the `}` matching the `{` at openIdx. AngelScript strings use both
 * quote styles and the bodies are full of `{` inside string literals and comments, so a
 * naive counter closes the block early.
 */
function blockEnd(content, openIdx) {
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = openIdx; i < content.length; i++) {
    const c = content[i];
    if (lineComment) {
      if (c === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === '*' && content[i + 1] === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && content[i + 1] === '/') {
      lineComment = true;
      i++;
    } else if (c === '/' && content[i + 1] === '*') {
      blockComment = true;
      i++;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return content.length;
}

/** Split a call's argument list on commas that are not nested inside parens or strings. */
function splitTopLevelArgs(argText) {
  const args = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let i = 0; i < argText.length; i++) {
    const c = argText[i];
    if (quote) {
      current += c;
      if (c === '\\') {
        current += argText[++i] ?? '';
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === '(' || c === '[') {
      depth++;
      current += c;
    } else if (c === ')' || c === ']') {
      depth--;
      current += c;
    } else if (c === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function unquote(text) {
  if (!text) return '';
  const m = /^["'](.*)["']$/s.exec(text.trim());
  return m ? m[1] : '';
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Fold a display name to its comparable core. The data writes "HK416(MOD3)" and
 * "AN-94(MOD3)-[Doll Trigger]" while users type "HK416 MOD3" and "人偶扳机", so spacing,
 * punctuation and bracket styles must not decide a match.
 */
function normalizeName(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[\s()[\]{}<>·'"“”‘’`\-_.,/\\|:;!?*+&#@~^%$]/g, '')
    .trim();
}

function collect(re, text, group = 1) {
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[group]);
  return out;
}

function attrOf(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? m[1] : undefined;
}

function numAttr(tag, name) {
  const raw = attrOf(tag, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// AngelScript parsing
// ---------------------------------------------------------------------------

/**
 * Read `dictionary <name> = { ... }`, attaching the `//` comment above each contiguous
 * run of entries as its label. The label is cleared by a blank line once it has been
 * consumed — without that, entries the author left uncommented (44, 45 in gameSkillIndex)
 * inherit the previous group's name and get mislabelled.
 */
function parseDictionary(content, dictName) {
  const start = content.indexOf(`dictionary ${dictName}`);
  if (start === -1) return [];
  const open = content.indexOf('{', start);
  if (open === -1) return [];
  const body = content.slice(open, blockEnd(content, open));

  const entries = [];
  let label = '';
  let labelUsed = false;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      if (labelUsed) {
        label = '';
        labelUsed = false;
      }
      continue;
    }
    if (line.startsWith('//')) {
      const text = line.slice(2).trim();
      if (text) {
        label = text;
        labelUsed = false;
      }
      continue;
    }
    const m = /\{\s*"([^"]*)"\s*,\s*(-?\d+)\s*\}/.exec(line);
    if (!m) continue;
    // `{"",0}` is the empty-weapon guard and `{"666",-1}` is the author's placeholder.
    if (!m[1] || m[1] === '666') continue;
    entries.push({ key: m[1], index: Number(m[2]), label });
    labelUsed = true;
  }
  return entries;
}

/** The two arrays checked before the switch — the weapons in them never reach a case arm. */
function parseFallbackArrays(content) {
  const out = [];
  const re = /(?:\/\/[ \t]*(.*)\r?\n)?[ \t]*array<string>\s+(AR_grenade_\w+)\s*=\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    out.push({
      name: m[2],
      label: (m[1] ?? '').trim(),
      keys: collect(/"([^"]+)"/g, m[3]),
    });
  }
  return out;
}

/** Every `excute*` function in commandskill.as, with its body and line range. */
function parseHandlers(content) {
  const starts = buildLineStarts(content);
  const handlers = new Map();
  const re = /^[ \t]*(?:void|int|bool|float)\s+(excute[A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    const open = re.lastIndex - 1;
    const close = blockEnd(content, open);
    handlers.set(m[1], {
      name: m[1],
      params: m[2].trim(),
      startLine: lineAt(starts, m.index),
      endLine: lineAt(starts, close),
      body: content.slice(open, close),
    });
  }
  return handlers;
}

/**
 * `case 36:{excuteHK416mod3skill(cId,senderId,m_modifer);break;}` → the handler for skill 36.
 * Anchoring at line start is what skips the commented-out arms (30, 45, 85).
 */
function parseSwitchArms(content) {
  const arms = new Map();
  const re = /^[ \t]*case\s+(\d+)\s*:\s*\{\s*(excute[A-Za-z0-9_]*)\s*\(([^)]*)\)/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    const args = splitTopLevelArgs(m[3]);
    arms.set(Number(m[1]), {
      handler: m[2],
      // Anything past (cId, senderId, m_modifer) selects a skin or variant branch.
      variantArgs: args.slice(3),
    });
  }
  return arms;
}

/** `case 8: {// HK416寄生榴弹 … }` — the trailing comment is the only machine-readable name. */
function parseCaseBodies(content) {
  const starts = buildLineStarts(content);
  const cases = new Map();
  const re = /^[ \t]*case\s+(\d+)\s*:[ \t]*\{/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    const open = re.lastIndex - 1;
    const close = blockEnd(content, open);
    const lineEnd = content.indexOf('\n', open);
    const comment = /\/\/[ \t]*(.+)$/.exec(
      content.slice(open, lineEnd === -1 ? content.length : lineEnd),
    );
    cases.set(Number(m[1]), {
      label: comment ? comment[1].trim() : '',
      startLine: lineAt(starts, m.index),
      endLine: lineAt(starts, close),
      body: content.slice(open, close),
    });
  }
  return cases;
}

/** Facts a `/skill` handler body states outright. Everything else is left to the source excerpt. */
function extractHandlerFacts(body) {
  const cooldowns = [];
  const cdRe = /addCooldown\s*\(([^;]*?)\)\s*;/g;
  let m;
  while ((m = cdRe.exec(body)) !== null) {
    const args = splitTopLevelArgs(m[1]);
    const key = unquote(args[0]);
    if (!key) continue;
    const seconds = Number(args[1]);
    const cooldown = { key, chargeMode: args[4] ? unquote(args[4]) || 'normal' : 'normal' };
    if (Number.isFinite(seconds)) cooldown.seconds = seconds;
    else cooldown.secondsExpr = args[1];
    if (args[5] && args[5].trim() === 'false') cooldown.alert = false;
    cooldowns.push(cooldown);
  }

  return {
    cooldowns,
    projectiles: uniq(collect(/["']([A-Za-z0-9_.-]+\.projectile)["']/g, body)),
    sounds: uniq(collect(/["']([A-Za-z0-9_.-]+\.wav)["']/g, body)),
    radii: uniq(
      collect(/getCharactersNearPosition\([^)]*?,\s*([0-9]+(?:\.[0-9]+)?)f?\s*\)/g, body),
    ).map(Number),
    equipmentGates: uniq(
      collect(/startsWith\(\s*[A-Za-z0-9_]+\s*,\s*['"]([^'"]+)['"]\s*\)/g, body),
    ),
    requiresAimTarget: /hasAttribute\(\s*"aim_target"\s*\)/.test(body),
    requiresCanCast: /canCastSkill\s*\(/.test(body),
  };
}

/** Facts a GFLskill case body states outright. */
function extractEffectFacts(body) {
  // Signature (GFLtask.as): (metagame, time, cId, fId, key, pos, trigger, time_internal, strict).
  // `time` is the delay before the FIRST tick and `time_internal` the gap between ticks —
  // two different numbers that are easy to collapse into one wrong "interval".
  const dot = [];
  const dotRe = /ConstantStaticProjectileEvent\s*\(([^;]*?)\)\s*;/g;
  let m;
  while ((m = dotRe.exec(body)) !== null) {
    const args = splitTopLevelArgs(m[1]);
    const initialDelaySeconds = Number(args[1]);
    const ticks = Number(args[6]);
    const intervalSeconds = Number(args[7]);
    const entry = {
      projectile: unquote(args[4]) || args[4],
      initialDelaySeconds,
      ticks,
      intervalSeconds,
      strictDeadCheck: args[8] ? args[8].trim() !== 'false' : true,
    };
    if ([initialDelaySeconds, ticks, intervalSeconds].every(Number.isFinite)) {
      // Fires at t=initialDelay, then every interval; the last of `ticks` fires here.
      entry.lastTickSeconds = Number(
        (initialDelaySeconds + (ticks - 1) * intervalSeconds).toFixed(3),
      );
    }
    dot.push(entry);
  }

  const trackerSpawns = [];
  const trackerRe = /(\w+)\s*\.insertLast\(\s*(\w*[Tt]rack\w*|\w*_?lister)\s*\(([^;]*?)\)\s*\)/g;
  while ((m = trackerRe.exec(body)) !== null) {
    trackerSpawns.push({ array: m[1], tracker: m[2], args: splitTopLevelArgs(m[3]) });
  }

  return {
    projectiles: uniq(collect(/["']([A-Za-z0-9_.-]+\.projectile)["']/g, body)),
    radii: uniq(
      collect(/getCharactersNearPosition\([^)]*?,\s*([0-9]+(?:\.[0-9]+)?)f?\s*\)/g, body),
    ).map(Number),
    dot,
    trackerSpawns,
    restoreAmounts: uniq(
      collect(/setIntAttribute\(\s*"untransform_count"\s*,\s*(\d+)\s*\)/g, body),
    ).map(Number),
  };
}

/**
 * Tracker classes in gfl_skill_info.as: field defaults plus which fields the constructor
 * fills from arguments, so a `UZI_tracker(cId, fid, pos, affected)` call site can be
 * resolved back to concrete timings.
 */
function parseTrackerClasses(content) {
  const classes = {};
  const re = /class\s+(\w+)\s*\{/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    const open = re.lastIndex - 1;
    const body = content.slice(open, blockEnd(content, open));

    const defaults = {};
    let f;
    const fieldRe = /(?:int|float|string)\s+(m_\w+)\s*=\s*([0-9.]+)\s*;/g;
    while ((f = fieldRe.exec(body)) !== null) defaults[f[1]] = Number(f[2]);

    const ctor = new RegExp(`${name}\\s*\\(([^)]*)\\)\\s*\\{`).exec(body);
    const fieldFromParam = {};
    let ctorParams = [];
    if (ctor) {
      ctorParams = splitTopLevelArgs(ctor[1]).map((p) =>
        p
          .split(/[\s@]+/)
          .filter(Boolean)
          .pop(),
      );
      const ctorOpen = body.indexOf('{', ctor.index + ctor[0].length - 1);
      const ctorBody = body.slice(ctorOpen, blockEnd(body, ctorOpen));
      let a;
      const assignRe = /(m_\w+)\s*=\s*(\w+)\s*;/g;
      while ((a = assignRe.exec(ctorBody)) !== null) fieldFromParam[a[1]] = a[2];
    }
    classes[name] = { name, defaults, ctorParams, fieldFromParam };
  }
  return classes;
}

/**
 * The re-arm loops in GFLskill.as::update(). This is where a tracker's real cadence lives
 * — the case body only registers the tracker, so reading the case alone reports a skill
 * that fires once when it actually fires several times at a different interval.
 */
function parseTrackerUpdates(content) {
  const starts = buildLineStarts(content);
  const arrayToClass = {};
  let d;
  const declRe = /array<\s*(\w+)\s*@?\s*>\s*(\w+)\s*;/g;
  while ((d = declRe.exec(content)) !== null) arrayToClass[d[2]] = d[1];

  const updateAt = content.search(/^\s*void\s+update\s*\(\s*float\s+time\s*\)\s*\{/m);
  if (updateAt === -1) return { arrayToClass, updates: {} };
  const updateOpen = content.indexOf('{', updateAt);
  const updateBody = content.slice(updateOpen, blockEnd(content, updateOpen));

  const updates = {};
  const blockRe = /if\s*\(\s*(\w+)\.length\(\)\s*>\s*0\s*\)\s*\{/g;
  let m;
  while ((m = blockRe.exec(updateBody)) !== null) {
    const array = m[1];
    const open = blockRe.lastIndex - 1;
    const end = blockEnd(updateBody, open);
    const body = updateBody.slice(open, end);

    const rearm = new RegExp(`${array}\\[a\\]\\.m_time\\s*=\\s*([^;]+);`).exec(body);
    const removeBelow = /m_numtime\s*<\s*(-?\d+)/.exec(body);
    const rearmRaw = rearm ? rearm[1].trim() : undefined;
    const rearmValue = rearmRaw === undefined ? NaN : Number(rearmRaw);
    updates[array] = {
      array,
      tracker: arrayToClass[array],
      ...(Number.isFinite(rearmValue)
        ? { intervalSeconds: rearmValue }
        : rearmRaw !== undefined
          ? { intervalExpr: rearmRaw }
          : {}),
      ...(removeBelow ? { removeWhenBelow: Number(removeBelow[1]) } : {}),
      // Some loops build instance_key by concatenating a field (`'" + t.m_projectile + "'`),
      // which would otherwise be captured as a garbage key. Keep only real keys; the field
      // is resolved from the constructor binding instead.
      projectiles: uniq(collect(/instance_key='([^']+)'/g, body)).filter((key) =>
        /^[A-Za-z0-9_.-]+$/.test(key),
      ),
      // Two different targeting shapes: one grenade per locked enemy, or one random pick.
      perLockedTarget: /m_affected\s*\[/.test(body),
      randomTarget: /\brand\s*\(/.test(body),
      radii: uniq(
        collect(/getCharactersNearPosition\([^)]*?,\s*([0-9]+(?:\.[0-9]+)?)f?\s*\)/g, body),
      ).map(Number),
      source: {
        startLine: lineAt(starts, updateOpen + m.index),
        endLine: lineAt(starts, updateOpen + end),
      },
    };
  }
  return { arrayToClass, updates };
}

/** Bind a tracker registration to its class defaults and its re-arm loop. */
function resolveTrackerFollowUp(spawn, classes, trackerUpdates, withPrefix) {
  const cls = classes[spawn.tracker];
  const loop = trackerUpdates.updates[spawn.array];
  if (!cls && !loop) return null;

  const followUp = { tracker: spawn.tracker, array: spawn.array };

  // A field is either a constructor argument at the call site or a class default.
  const fieldValue = (field) => {
    const param = cls?.fieldFromParam?.[field];
    if (param) {
      const at = cls.ctorParams.indexOf(param);
      const raw = at >= 0 ? spawn.args[at] : undefined;
      const num = Number(raw);
      if (Number.isFinite(num)) return num;
      if (raw !== undefined) return { expr: raw };
    }
    return cls?.defaults?.[field];
  };

  const initial = fieldValue('m_time');
  if (typeof initial === 'number') followUp.initialDelaySeconds = initial;
  else if (initial) followUp.initialDelayExpr = initial.expr;

  if (loop) {
    if (loop.intervalSeconds !== undefined) followUp.intervalSeconds = loop.intervalSeconds;
    else if (loop.intervalExpr !== undefined) {
      // `m_time = m_time_interval` — the real number is whatever the constructor bound.
      const field = /\bm_\w+/.exec(loop.intervalExpr);
      const resolved = field ? fieldValue(field[0]) : undefined;
      if (typeof resolved === 'number') followUp.intervalSeconds = resolved;
      else followUp.intervalExpr = loop.intervalExpr;
    }

    const projectiles = [...loop.projectiles];
    if (projectiles.length === 0) {
      // Loop emits a field-held key; recover it from the call site.
      for (const field of Object.keys(cls?.fieldFromParam ?? {})) {
        const bound = fieldValue(field);
        const literal = typeof bound === 'object' ? unquote(bound.expr) : '';
        if (literal.endsWith('.projectile')) projectiles.push(literal);
      }
    }
    if (projectiles.length > 0) followUp.projectiles = uniq(projectiles);
    if (loop.perLockedTarget) followUp.perLockedTarget = true;
    if (loop.randomTarget) followUp.randomTarget = true;
    if (loop.radii.length > 0) followUp.radii = loop.radii;
    followUp.source = {
      file: withPrefix('scripts/trackers/GFLskill.as'),
      startLine: loop.source.startLine,
      endLine: loop.source.endLine,
    };

    // The loop decrements m_numtime, fires, then drops the tracker once it falls below
    // the threshold — so the count of volleys is start - threshold + 1.
    const numtime = fieldValue('m_numtime');
    if (typeof numtime === 'number' && loop.removeWhenBelow !== undefined) {
      followUp.repeats = numtime - loop.removeWhenBelow + 1;
    }
  }
  return followUp;
}

/**
 * The armor-driven cooldown modifiers applied to every skill before dispatch.
 * Effective cooldown is `max(seconds * multiplier - minus, 0.1)`.
 */
function extractCooldownModifiers(content) {
  const anchor = content.indexOf('Weapon_free_of_other_cooldown.find(');
  if (anchor === -1) return [];
  const region = content.slice(anchor, content.indexOf('switch(', anchor));
  const modifiers = [];
  const re = /startsWith\(\s*c_armorType\s*,\s*'([^']+)'\s*\)\s*\)\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = re.exec(region)) !== null) {
    const entry = { armorKey: m[1] };
    const mul = /setCooldownReduction\(\s*([0-9.]+)\s*\)/.exec(m[2]);
    const minus = /setCooldownMinus\(\s*([0-9.]+)\s*\)/.exec(m[2]);
    if (mul) entry.multiplier = Number(mul[1]);
    if (minus) entry.minusSeconds = Number(minus[1]);
    modifiers.push(entry);
  }
  return modifiers;
}

// ---------------------------------------------------------------------------
// XML parsing
// ---------------------------------------------------------------------------

/**
 * `<weapon>` and `<projectile>` files hold several blocks each (1574 weapons in 1119
 * files, 2050 projectiles in 349), so taking only the first would silently drop most
 * of the data. `\b` keeps `<weapon` from matching the `<weapons>` wrapper.
 */
function splitBlocks(content, tag) {
  return content.split(new RegExp(`(?=<${tag}\\b)`)).slice(1);
}

function parseProjectileContent(content, relFile, projectiles) {
  for (const block of splitBlocks(content, 'projectile')) {
    const head = /<projectile\b[^>]*>/.exec(block);
    if (!head) continue;
    const key = attrOf(head[0], 'key');
    if (!key) continue;

    const record = { file: relFile, blasts: [], spawns: [] };
    for (const tag of collect(/(<result\b[^>]*>)/g, block)) {
      const cls = attrOf(tag, 'class');
      if (cls === 'notify_script') {
        record.notifyScript = attrOf(tag, 'key');
      } else if (cls === 'blast') {
        record.blasts.push({
          radius: numAttr(tag, 'radius'),
          damage: numAttr(tag, 'damage'),
          push: numAttr(tag, 'push'),
        });
      } else if (cls === 'spawn') {
        const instanceKey = attrOf(tag, 'instance_key');
        if (instanceKey) {
          record.spawns.push({
            key: instanceKey,
            minAmount: numAttr(tag, 'min_amount'),
            maxAmount: numAttr(tag, 'max_amount'),
          });
        }
      }
    }
    projectiles[key] = record;
  }
}

const SPEC_FIELDS = [
  'class',
  'slot',
  'magazine_size',
  'accuracy_factor',
  'projectile_speed',
  'retrigger_time',
  'spread_range',
];

function parseWeaponContent(content, relFile, weapons) {
  for (const block of splitBlocks(content, 'weapon')) {
    const head = /<weapon\b[^>]*>/.exec(block);
    if (!head) continue;
    const key = attrOf(head[0], 'key');
    if (!key) continue;

    // Attributes routinely span several lines, so `[^>]` (which matches newlines) is
    // the whole point here.
    const spec = /<specification\b[^>]*>/.exec(block);
    const record = { key, file: relFile, name: spec ? (attrOf(spec[0], 'name') ?? '') : '' };
    if (spec) {
      const stats = {};
      for (const field of SPEC_FIELDS) {
        const value = attrOf(spec[0], field);
        if (value !== undefined) stats[field] = value;
      }
      if (Object.keys(stats).length > 0) record.spec = stats;
    }
    weapons[key] = record;
  }
}

// ---------------------------------------------------------------------------
// Localization / trait resolution
// ---------------------------------------------------------------------------

/** `AS Val Shaft-[Fireworks of Dreams](MOD3)-[Belief]` → base + ['Fireworks of Dreams', 'Belief'] */
function splitTraits(name) {
  const at = name.indexOf('-[');
  if (at === -1) return { base: name, traits: [] };
  return {
    base: name.slice(0, at),
    traits: collect(/\[([^\]]*)\]/g, name.slice(at)),
  };
}

function pairTraits(enName, cnName) {
  const en = splitTraits(enName);
  const cn = cnName ? splitTraits(cnName) : { traits: [] };
  return en.traits.map((trait, i) => ({ en: trait, cn: cn.traits[i] ?? '' }));
}

/**
 * Resolve a weapon's display name into its skill trait and its skin names.
 *
 * Only a name carrying *two* brackets states the answer outright: there the last one is
 * the MOD/skill trait and the earlier ones are skin names (`AN-94(MOD3)-[沉默嫣红]-[人偶扳机]`).
 * A single bracket is ambiguous — `HK416(MOD3)-[千宵草味的锡纸糖]` is a skin, while
 * `HK416(MOD3)-[寄生榴弹]` is the skill — and the base weapon usually carries no bracket
 * at all, because the trait lives only in GFL_alltext.xml. So for those we expand every
 * localization key sharing the base name and take the last-bracket that recurs most
 * often; the skill trait is shared across skins, so it outnumbers them. When every
 * candidate is a singleton the name alone cannot decide, and the caller disambiguates
 * against the effect label instead of guessing.
 */
function resolveTraits(weaponName, cnByEn, keysByBase) {
  const empty = { skillTrait: null, skinTraits: [], traitCandidates: [] };
  if (!weaponName) return empty;

  const direct = cnByEn[weaponName];
  const own = splitTraits(weaponName);
  if (own.traits.length >= 2) {
    const pairs = pairTraits(weaponName, direct);
    return {
      nameCn: direct,
      skillTrait: pairs[pairs.length - 1],
      skinTraits: pairs.slice(0, -1),
      traitCandidates: [],
    };
  }

  // Single-bracket names are skin variants; the skill trait, if any, is a sibling of
  // theirs under the same base name. Base names are matched normalized because the
  // weapon file and the localization file disagree on spacing (`UMP9(MOD3)` vs
  // `UMP9 (MOD3)`), which an exact join silently drops.
  const ownPairs = own.traits.length === 1 ? pairTraits(weaponName, direct) : [];
  const expanded = keysByBase[normalizeName(own.base)] ?? [];
  if (expanded.length === 0) {
    return { nameCn: direct, skillTrait: null, skinTraits: ownPairs, traitCandidates: [] };
  }

  const byLastTrait = new Map();
  for (const key of expanded) {
    const pairs = pairTraits(key, cnByEn[key]);
    const last = pairs[pairs.length - 1];
    if (!last) continue;
    const seen = byLastTrait.get(last.en);
    if (seen) seen.count++;
    else byLastTrait.set(last.en, { trait: last, count: 1 });
  }

  const ranked = [...byLastTrait.values()].sort((a, b) => b.count - a.count);
  const candidates = ranked.map((entry) => entry.trait);
  const decided = ranked.length === 1 || (ranked.length > 1 && ranked[0].count > ranked[1].count);
  return {
    nameCn: direct,
    skillTrait: decided ? ranked[0].trait : null,
    skinTraits: ownPairs,
    traitCandidates: decided ? [] : candidates,
  };
}

/**
 * Last resort for weapons whose bracket candidates are all singletons: the effect label
 * names the skill in Chinese (`HK416寄生榴弹`), so the candidate it contains is the skill
 * trait and the rest are skin names.
 */
function disambiguateByEffectLabel(skill) {
  const labels = skill.effects.map((effect) => effect.label).filter(Boolean);
  if (labels.length === 0) return;
  for (const weapon of skill.weapons) {
    if (weapon.skillTrait || !weapon.traitCandidates) continue;
    const match = weapon.traitCandidates.find(
      (trait) => trait.cn && labels.some((label) => label.includes(trait.cn)),
    );
    if (!match) continue;
    weapon.skillTrait = match;
    // Whatever is left are sibling weapons' skin names, not this weapon's — keeping them
    // would just repeat skinTraits back at the model as unresolved alternatives.
    delete weapon.traitCandidates;
  }
}

// ---------------------------------------------------------------------------
// Index build
// ---------------------------------------------------------------------------

async function readPackageDir(sourceDir, subdir, filter) {
  const dir = path.join(sourceDir, subdir);
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const wanted = names.filter(filter);
  const contents = await Promise.all(
    wanted.map((name) => fs.readFile(path.join(dir, name), 'utf-8').catch(() => undefined)),
  );
  return wanted.map((name, i) => ({ relFile: `${subdir}/${name}`, content: contents[i] }));
}

/** BFS the `<result class="spawn">` graph, which is where the damage numbers actually sit. */
function walkProjectileChain(seeds, projectiles, visited, chain) {
  let frontier = uniq(seeds).map((key) => ({ key, depth: 1 }));
  while (frontier.length > 0 && chain.length < CHAIN_MAX_NODES) {
    const next = [];
    for (const { key, depth } of frontier) {
      if (visited.has(key) || chain.length >= CHAIN_MAX_NODES) continue;
      visited.add(key);
      const record = projectiles[key];
      if (!record) {
        // Chains routinely end in base-game assets that are not shipped with the mod.
        chain.push({ projectile: key, depth, unresolved: true });
        continue;
      }
      const node = { projectile: key, depth, file: record.file };
      if (record.blasts.length > 0) node.blasts = record.blasts;
      if (record.notifyScript) node.notifyScript = record.notifyScript;
      chain.push(node);
      if (depth < CHAIN_MAX_DEPTH) {
        for (const spawn of record.spawns) next.push({ key: spawn.key, depth: depth + 1 });
      }
    }
    frontier = next;
  }
}

async function buildIndex(sourceDir, dataDir) {
  // Every emitted path is relative to DATA_DIR, because that is what the built-in
  // readSource resolves against — package-relative paths make the model's follow-up read
  // fail with "File not found". Empty when DATA_DIR is itself the package.
  const pathPrefix = path.relative(dataDir, sourceDir).split(path.sep).filter(Boolean).join('/');
  const withPrefix = (relFile) => (pathPrefix ? `${pathPrefix}/${relFile}` : relFile);

  const [commandInfo, commandSkill, skillInfo, gflSkill, alltext] = await Promise.all([
    readIfExists(path.join(sourceDir, 'scripts', 'core', 'command_skill_info.as')),
    readIfExists(path.join(sourceDir, 'scripts', 'trackers', 'commandskill.as')),
    readIfExists(path.join(sourceDir, 'scripts', 'core', 'gfl_skill_info.as')),
    readIfExists(path.join(sourceDir, 'scripts', 'trackers', 'GFLskill.as')),
    readIfExists(path.join(sourceDir, 'languages', 'cn', 'GFL_alltext.xml')),
  ]);

  // Step 1 — weapon key → skill index, plus the two arrays checked before the switch.
  const weaponEntries = commandInfo ? parseDictionary(commandInfo, 'commandSkillIndex') : [];
  const fallbackArrays = commandInfo ? parseFallbackArrays(commandInfo) : [];

  // Step 2 — switch arms and handler bodies.
  const arms = commandSkill ? parseSwitchArms(commandSkill) : new Map();
  const handlers = commandSkill ? parseHandlers(commandSkill) : new Map();
  const cooldownModifiers = commandSkill ? extractCooldownModifiers(commandSkill) : [];

  // Step 3/4 — script skill key → game index → effect body.
  const gameSkillEntries = skillInfo ? parseDictionary(skillInfo, 'gameSkillIndex') : [];
  const gameSkillByKey = {};
  for (const entry of gameSkillEntries) gameSkillByKey[entry.key] = entry;
  const effectCases = gflSkill ? parseCaseBodies(gflSkill) : new Map();
  // A case body only registers a tracker; its cadence lives in GFLskill.as::update().
  const trackerClasses = skillInfo ? parseTrackerClasses(skillInfo) : {};
  const trackerUpdates = gflSkill
    ? parseTrackerUpdates(gflSkill)
    : { arrayToClass: {}, updates: {} };

  // Step 5/6 — projectile and weapon XML.
  const projectiles = {};
  const weapons = {};
  const [projectileFiles, weaponFiles] = await Promise.all([
    readPackageDir(sourceDir, 'weapons', (n) => n.endsWith('.projectile')),
    readPackageDir(sourceDir, 'weapons', (n) => n.endsWith('.weapon') && n !== MERGED_WEAPON_FILE),
  ]);
  for (const { relFile, content } of projectileFiles) {
    if (content) parseProjectileContent(content, withPrefix(relFile), projectiles);
  }
  for (const { relFile, content } of weaponFiles) {
    if (content) parseWeaponContent(content, withPrefix(relFile), weapons);
  }

  // Step 7 — localization, and the bracketed trait registry derived from it.
  const cnByEn = {};
  if (alltext) {
    let m;
    const re = /<text\s+key="([^"]+)"\s+text="([^"]+)"/g;
    while ((m = re.exec(alltext)) !== null) cnByEn[m[1]] = m[2];
  }
  const keysByBase = {};
  for (const key of Object.keys(cnByEn)) {
    const { base, traits } = splitTraits(key);
    if (traits.length === 0) continue;
    (keysByBase[normalizeName(base)] ??= []).push(key);
  }

  // ---- assemble one record per skill --------------------------------------

  const weaponKeysBySkill = new Map();
  const labelBySkill = new Map();
  for (const entry of weaponEntries) {
    if (!weaponKeysBySkill.has(entry.index)) weaponKeysBySkill.set(entry.index, []);
    weaponKeysBySkill.get(entry.index).push(entry.key);
    if (entry.label && !labelBySkill.has(entry.index)) labelBySkill.set(entry.index, entry.label);
  }

  const targets = [];
  for (const [index, keys] of weaponKeysBySkill) {
    const arm = arms.get(index);
    if (!arm) continue; // commented-out arm (30, 45, 85) — the weapons have no live skill
    targets.push({
      id: index,
      label: labelBySkill.get(index) ?? '',
      handler: arm.handler,
      variantArgs: arm.variantArgs,
      weaponKeys: keys,
    });
  }
  for (const array of fallbackArrays) {
    const handler =
      array.name === 'AR_grenade_AntiArmor' ? 'excuteAntiArmorskill' : 'excuteAntiPersonalskill';
    targets.push({
      id: array.name,
      label: array.label,
      handler,
      variantArgs: [],
      weaponKeys: array.keys,
      viaFallbackArray: array.name,
    });
  }

  const skills = targets.map((target) => {
    const handler = handlers.get(target.handler);
    const facts = handler ? extractHandlerFacts(handler.body) : null;

    const skill = {
      id: target.id,
      label: target.label,
      command: '/skill',
      handler: target.handler,
      weapons: target.weaponKeys.map((key) => {
        const weapon = weapons[key];
        if (!weapon) return { key, weaponMissing: true };
        const traits = resolveTraits(weapon.name, cnByEn, keysByBase);
        const record = { key, name: weapon.name, file: weapon.file };
        if (traits.nameCn) record.nameCn = traits.nameCn;
        if (traits.skillTrait) record.skillTrait = traits.skillTrait;
        if (traits.skinTraits.length > 0) record.skinTraits = traits.skinTraits;
        if (traits.traitCandidates.length > 0) record.traitCandidates = traits.traitCandidates;
        if (weapon.spec) record.spec = weapon.spec;
        return record;
      }),
    };
    if (target.variantArgs.length > 0) skill.variantArgs = target.variantArgs;
    if (target.viaFallbackArray) skill.viaFallbackArray = target.viaFallbackArray;

    if (facts) {
      skill.cooldowns = facts.cooldowns;
      skill.requiresAimTarget = facts.requiresAimTarget;
      skill.requiresCanCast = facts.requiresCanCast;
      if (facts.radii.length > 0) skill.radii = facts.radii;
      if (facts.sounds.length > 0) skill.sounds = facts.sounds;
      if (facts.equipmentGates.length > 0) skill.equipmentGates = facts.equipmentGates;
      skill.projectiles = facts.projectiles;
      skill.source = {
        file: withPrefix('scripts/trackers/commandskill.as'),
        startLine: handler.startLine,
        endLine: handler.endLine,
      };
    } else {
      skill.projectiles = [];
      skill.note = `Handler ${target.handler}() not found in commandskill.as`;
    }

    // Command side → projectile → notify_script → effect side, then the effect's own
    // projectiles, all sharing one visited set and one node budget.
    const visited = new Set();
    const damageChain = [];
    walkProjectileChain(skill.projectiles, projectiles, visited, damageChain);

    const effects = [];
    const effectSeeds = [];
    for (const skillKey of uniq(damageChain.map((node) => node.notifyScript))) {
      const gameSkill = gameSkillByKey[skillKey];
      const effect = { skillKey };
      if (gameSkill) {
        effect.gameIndex = gameSkill.index;
        effect.label = gameSkill.label;
        const body = effectCases.get(gameSkill.index);
        if (body) {
          if (body.label) effect.label = body.label;
          const effectFacts = extractEffectFacts(body.body);
          if (effectFacts.radii.length > 0) effect.radii = effectFacts.radii;
          if (effectFacts.dot.length > 0) effect.dot = effectFacts.dot;
          if (effectFacts.restoreAmounts.length > 0) {
            effect.restoreAmounts = effectFacts.restoreAmounts;
          }
          effect.spawnedProjectiles = effectFacts.projectiles;
          effect.source = {
            file: withPrefix('scripts/trackers/GFLskill.as'),
            startLine: body.startLine,
            endLine: body.endLine,
          };
          effectSeeds.push(...effectFacts.projectiles);

          // Delayed volleys fired from update(), not from the case body — without these
          // the skill looks like it resolves instantly.
          const followUps = effectFacts.trackerSpawns
            .map((spawn) =>
              resolveTrackerFollowUp(spawn, trackerClasses, trackerUpdates, withPrefix),
            )
            .filter(Boolean);
          if (followUps.length > 0) {
            effect.followUp = followUps;
            for (const entry of followUps) effectSeeds.push(...(entry.projectiles ?? []));
          }
          for (const tick of effectFacts.dot) {
            if (tick.projectile) effectSeeds.push(tick.projectile);
          }
        }
      } else {
        effect.note = 'Skill key is not registered in gameSkillIndex — handled by another tracker';
      }
      effects.push(effect);
    }
    walkProjectileChain(effectSeeds, projectiles, visited, damageChain);

    skill.effects = effects;
    skill.damageChain = damageChain;
    if (skill.cooldowns?.length && cooldownModifiers.length > 0) {
      skill.cooldownModifiers = cooldownModifiers;
      skill.cooldownFormula = 'max(seconds * multiplier - minusSeconds, 0.1)';
    }
    disambiguateByEffectLabel(skill);
    return skill;
  });

  // ---- lookup indices ------------------------------------------------------

  const weaponKeyIndex = {};
  const handlerIndex = {};
  const skillKeyIndex = {};
  const projectileToSkill = {};

  const put = (map, key, position) => {
    if (!key) return;
    const lower = String(key).toLowerCase();
    if (map[lower] === undefined) map[lower] = position;
  };

  /**
   * One flat, normalized list rather than a map per name kind. Users type "HK416 MOD3"
   * for a weapon the data calls "HK416(MOD3)", so matching has to ignore spacing and
   * punctuation, and candidates have to be scored against each other — first-hit-wins
   * over a plain map answers "HK416 MOD3" with plain HK416.
   */
  const names = [];
  const seen = new Set();
  const addName = (raw, kind, position) => {
    const norm = normalizeName(raw);
    if (!norm) return;
    const dedupe = `${kind}:${norm}:${position}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    names.push({ norm, raw, kind, position });
  };

  skills.forEach((skill, position) => {
    put(handlerIndex, skill.handler, position);
    for (const projectile of skill.projectiles) put(projectileToSkill, projectile, position);
    for (const node of skill.damageChain) put(projectileToSkill, node.projectile, position);
    for (const effect of skill.effects) {
      put(skillKeyIndex, effect.skillKey, position);
      // The effect comment (`HK416寄生榴弹`) is often the only place the skill's Chinese
      // name is written down — without it, "寄生榴弹" finds nothing.
      addName(effect.label, 'cn_trait', position);
    }
    // The dictionary group comment (`SMG燃烧弹`, `AN94MOD3`) names the skill too.
    addName(skill.label, 'cn_trait', position);
    for (const weapon of skill.weapons) {
      put(weaponKeyIndex, weapon.key, position);
      addName(weapon.name, 'en_name', position);
      addName(weapon.nameCn, 'cn_name', position);
      // Candidates are indexed alongside decided traits: they are real names from the
      // data, and a user typing a skin name still wants this weapon's skill back.
      for (const trait of [
        weapon.skillTrait,
        ...(weapon.skinTraits ?? []),
        ...(weapon.traitCandidates ?? []),
      ]) {
        if (!trait) continue;
        addName(trait.en, 'en_trait', position);
        addName(trait.cn, 'cn_trait', position);
      }
    }
  });

  /**
   * Most of the 751 bracketed traits belong to weapons with no entry in
   * commandSkillIndex — `ST-AR15(MOD3)-[罪与罚]` is a passive trait, not a `/skill`.
   * Answering those with a bare miss reads as "the data does not exist", so they get
   * their own registry and an explicit "no active skill" answer instead.
   */
  const weaponsByNormName = {};
  for (const [key, weapon] of Object.entries(weapons)) {
    if (!weapon.name) continue;
    (weaponsByNormName[normalizeName(weapon.name)] ??= []).push(key);
  }
  const covered = new Set(names.map((entry) => entry.norm));
  const passiveTraits = [];
  const passiveSeen = new Set();
  for (const [enKey, cnText] of Object.entries(cnByEn)) {
    const pairs = pairTraits(enKey, cnText);
    if (pairs.length === 0) continue;
    const { base } = splitTraits(enKey);
    const weaponKeys =
      weaponsByNormName[normalizeName(enKey)] ?? weaponsByNormName[normalizeName(base)] ?? [];
    for (const trait of pairs) {
      for (const [raw, lang] of [
        [trait.cn, 'cn'],
        [trait.en, 'en'],
      ]) {
        const norm = normalizeName(raw);
        if (!norm || covered.has(norm) || passiveSeen.has(norm)) continue;
        passiveSeen.add(norm);
        passiveTraits.push({
          norm,
          lang,
          trait,
          weaponName: enKey,
          weaponNameCn: cnText,
          weaponKeys,
        });
      }
    }
  }

  return {
    version: INDEX_VERSION,
    built_at: new Date().toISOString(),
    source_dir: sourceDir,
    path_prefix: pathPrefix,
    skills,
    weapons,
    weaponKeyIndex,
    handlerIndex,
    skillKeyIndex,
    projectileToSkill,
    names,
    passiveTraits,
  };
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

const CJK = /[一-鿿]/gu;

function cjkChars(text) {
  return new Set(text.match(CJK) ?? []);
}

/** Ties an ambiguous match to the kind of name a user is most likely naming. */
const KIND_RANK = { cn_trait: 4, cn_name: 3, en_trait: 2, en_name: 1 };

/** Ordered so an exact identifier always beats a fuzzy name match. */
function matchSkill(index, query) {
  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();

  for (const [matchedBy, map] of [
    ['weapon_key', index.weaponKeyIndex],
    ['skill_key', index.skillKeyIndex],
    ['handler', index.handlerIndex],
    ['projectile', index.projectileToSkill],
  ]) {
    if (map[lower] !== undefined) return { matchedBy, position: map[lower] };
  }

  const norm = normalizeName(trimmed);
  if (norm) {
    // Exact on the normalized form, then containment scored by how much of the name the
    // query actually pins down — the longest match is the most specific one.
    let best = null;
    for (const entry of index.names) {
      let score = null;
      if (entry.norm === norm) score = Number.MAX_SAFE_INTEGER;
      else if (entry.norm.includes(norm) || norm.includes(entry.norm)) {
        score = Math.min(entry.norm.length, norm.length);
      }
      if (score === null) continue;
      const rank = KIND_RANK[entry.kind] ?? 0;
      if (!best || score > best.score || (score === best.score && rank > best.rank)) {
        best = { matchedBy: entry.kind, position: entry.position, score, rank, name: entry.raw };
      }
    }
    if (best) return { matchedBy: best.matchedBy, position: best.position, matchedName: best.name };
  }

  // Character-level fuzzy match for partial Chinese queries.
  const queryChars = cjkChars(lower);
  if (queryChars.size >= 2) {
    let best = null;
    for (const entry of index.names) {
      if (entry.kind !== 'cn_trait' && entry.kind !== 'cn_name') continue;
      const nameChars = cjkChars(entry.raw.toLowerCase());
      let overlap = 0;
      for (const ch of queryChars) if (nameChars.has(ch)) overlap++;
      if (overlap / queryChars.size >= 0.6 && (!best || overlap > best.overlap)) {
        best = {
          matchedBy: `${entry.kind}_fuzzy`,
          position: entry.position,
          overlap,
          name: entry.raw,
        };
      }
    }
    if (best) return { matchedBy: best.matchedBy, position: best.position, matchedName: best.name };
  }

  for (const [matchedBy, map] of [
    ['weapon_key', index.weaponKeyIndex],
    ['projectile', index.projectileToSkill],
    ['handler', index.handlerIndex],
  ]) {
    for (const [key, position] of Object.entries(map)) {
      if (key.includes(lower)) return { matchedBy, position };
    }
  }

  return null;
}

/** Same normalized ladder as matchSkill, over traits that have no `/skill` handler. */
function matchPassiveTrait(index, query) {
  const norm = normalizeName(query);
  if (!norm) return null;
  let best = null;
  for (const entry of index.passiveTraits) {
    let score = null;
    if (entry.norm === norm) score = Number.MAX_SAFE_INTEGER;
    else if (entry.norm.includes(norm) || norm.includes(entry.norm)) {
      score = Math.min(entry.norm.length, norm.length);
    }
    if (score === null) continue;
    const rank = entry.lang === 'cn' ? 1 : 0;
    if (!best || score > best.score || (score === best.score && rank > best.rank)) {
      best = { entry, score, rank };
    }
  }
  return best?.entry ?? null;
}

/** Particles shared by most Chinese phrases carry no matching signal. */
const CJK_STOPWORDS = new Set([
  '的',
  '了',
  '是',
  '在',
  '有',
  '和',
  '与',
  '个',
  '会',
  '被',
  '多',
  '少',
]);

/**
 * Near-misses worth showing, or nothing at all. A loose bar produced the same three names
 * for "激光剑的伤害" and "不存在的东西xyz" — they shared only "的" — which dresses noise up as
 * a real lead and invites answering about a weapon the user never asked for. When a thing
 * genuinely is not in the data, an empty list is the honest result.
 */
function suggestions(index, query) {
  const queryChars = new Set(
    [...cjkChars(query.toLowerCase())].filter((c) => !CJK_STOPWORDS.has(c)),
  );
  if (queryChars.size === 0) return [];
  const scored = [];
  for (const entry of index.names) {
    if (entry.kind !== 'cn_trait') continue;
    const nameChars = cjkChars(entry.raw.toLowerCase());
    let overlap = 0;
    for (const ch of queryChars) if (nameChars.has(ch)) overlap++;
    if (overlap >= 2 && overlap / queryChars.size >= 0.5) scored.push({ name: entry.raw, overlap });
  }
  return uniq(
    scored
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 3)
      .map((entry) => entry.name),
  );
}

/**
 * Source stays on disk rather than in the cache, so excerpts never go stale. The stored
 * path is DATA_DIR-relative for the model's benefit, so the package prefix comes back off
 * before resolving against the package directory.
 */
async function readLines(index, relFile, startLine, endLine, cap) {
  const prefix = index.path_prefix ? `${index.path_prefix}/` : '';
  const inPackage = relFile.startsWith(prefix) ? relFile.slice(prefix.length) : relFile;
  const content = await readIfExists(path.join(index.source_dir, inPackage));
  if (content === undefined) return undefined;
  const excerpt = content
    .split('\n')
    .slice(startLine - 1, endLine)
    .join('\n');
  return excerpt.length > cap ? `${excerpt.slice(0, cap)}\n… (truncated)` : excerpt;
}

/**
 * Guidance for reading the timing fields, attached to the result rather than to the tool
 * description. A description is spent on every query in the session; this is spent only
 * when a skill with delayed effects is actually returned — and putting it in the
 * description measurably derailed unrelated eval cases.
 */
function readingNotes(skill) {
  const notes = [];
  const effects = skill.effects ?? [];
  if (effects.some((effect) => effect.dot?.length)) {
    notes.push(
      'dot[]: initialDelaySeconds is the wait before the FIRST tick, intervalSeconds the gap ' +
        'between ticks, lastTickSeconds when the final tick lands. Do not report the initial ' +
        'delay as the tick interval.',
    );
  }
  if (effects.some((effect) => effect.followUp?.length)) {
    notes.push(
      'followUp[]: delayed volleys fired from GFLskill.as::update(), not from the effect case. ' +
        'perLockedTarget means one projectile per locked enemy per repeat.',
    );
  }
  return notes;
}

/** @type {import('../types/tool-plugin.js').PluginFactory} */
export default function register(host) {
  /** @type {Promise<object|null>|null} */
  let indexPromise = null;

  function getIndex() {
    indexPromise ??= (async () => {
      // Applicability is decided before the cache is read: the cached artifact is Castling's,
      // and serving it to a request scoped to another package is exactly the cross-package
      // answer the scope exists to prevent.
      let roots = await findCastlingRoots(host.config.dataDir);
      if (host.scope) roots = roots.filter((dir) => path.basename(dir) === host.scope);
      if (roots.length === 0) return null;

      const cachePath = path.join(host.config.outputDir, 'skill-index.json');
      try {
        const cached = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
        if (cached.version === INDEX_VERSION && cached.source_dir === roots[0]) return cached;
      } catch {
        /* no usable cache — build below */
      }

      const index = await buildIndex(roots[0], host.config.dataDir);
      host.log(`skill index: ${index.skills.length} skills from ${roots[0]}`);
      try {
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.writeFile(cachePath, JSON.stringify(index), 'utf-8');
      } catch (err) {
        host.log(`skill index not cached (${err.message}) — will rebuild next boot`);
      }
      return index;
    })();
    return indexPromise;
  }

  return [
    {
      name: 'lookupWeaponSkill',
      description:
        'Look up Castling mod weapon skill traits (技能特色) by Chinese trait name, Chinese or English ' +
        'weapon name, weapon key, script skill key, projectile key, or handler function name. ' +
        'Joins the full chain that no other tool can follow: weapon key → /skill command handler ' +
        '(cooldown seconds, aim requirement, sounds) → projectile → notify_script → GFLskill effect case ' +
        '(radius, damage-over-time, heal amounts) → spawned projectile chain (blast radius and damage). ' +
        'Use to answer "HK416 MOD3 的技能特色是什么", "寄生榴弹伤害多少", "白鸮轰鸣冷却多久", ' +
        'or "40mm_hk416.projectile 是哪个技能用的". ' +
        'Returns the extracted facts plus the AngelScript source excerpt and its line range, so the ' +
        'source can be read further with readSource.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Skill trait name (Chinese or English), weapon name, weapon key, skill key, projectile key, or handler function name',
          },
          includeSource: {
            type: 'boolean',
            description:
              'Embed the handler and effect AngelScript source excerpts. Default true; set false for a compact answer.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute({ query, includeSource = true }) {
        const index = await getIndex();
        // Not a Castling-style package: report it instead of throwing, so the model
        // can fall back to normal retrieval.
        if (!index) {
          return {
            query,
            found: false,
            reason: host.scope
              ? `Package "${host.scope}" is not a Castling-style mod (no languages/cn/GFL_alltext.xml) — this tool has nothing for it. Do not answer from another package.`
              : 'No package with languages/cn/GFL_alltext.xml under DATA_DIR — this tool only covers Castling-style mods.',
          };
        }

        const hit = matchSkill(index, query);
        if (!hit) {
          const passive = matchPassiveTrait(index, query);
          if (passive) {
            return {
              query,
              found: true,
              kind: 'passive_trait',
              scope: host.scope,
              trait: passive.trait,
              weaponName: passive.weaponName,
              weaponNameCn: passive.weaponNameCn,
              weapons: passive.weaponKeys.map((key) => index.weapons[key] ?? { key }),
              note:
                'This trait has no entry in commandSkillIndex, so the weapon has no /skill command skill — ' +
                'it is a passive or display-only trait. Read the weapon file for its stats.',
            };
          }
          // State the absence rather than leaving a bare `found: false` next to a list of
          // names, which reads as "here are some candidates" and invites answering about
          // a weapon nobody asked for.
          const didYouMean = suggestions(index, query);
          return {
            query,
            found: false,
            scope: host.scope,
            reason: `No weapon skill or skill trait in the Castling data matches "${query}". This tool covers every /skill command skill and every -[trait] name in the package, so a miss here is real evidence the thing does not exist — say so instead of substituting a similar name.`,
            ...(didYouMean.length > 0
              ? { didYouMean, didYouMeanNote: 'Unrelated near-matches, not answers.' }
              : {}),
          };
        }

        const skill = { ...index.skills[hit.position] };
        if (includeSource) {
          if (skill.source) {
            skill.sourceExcerpt = await readLines(
              index,
              skill.source.file,
              skill.source.startLine,
              skill.source.endLine,
              HANDLER_EXCERPT_CHARS,
            );
          }
          skill.effects = await Promise.all(
            skill.effects.map(async (effect) => {
              if (!effect.source) return effect;
              return {
                ...effect,
                sourceExcerpt: await readLines(
                  index,
                  effect.source.file,
                  effect.source.startLine,
                  effect.source.endLine,
                  EFFECT_EXCERPT_CHARS,
                ),
              };
            }),
          );
        }

        const notes = readingNotes(skill);
        return {
          query,
          found: true,
          matchedBy: hit.matchedBy,
          scope: host.scope,
          skill,
          ...(notes.length > 0 ? { readingNotes: notes } : {}),
        };
      },
    },
  ];
}
