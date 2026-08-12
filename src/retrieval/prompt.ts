// Same script-aware estimator the token accounting uses, so the budget here and the numbers reported
// on `finish` are measured the same way.
import { estimateTokens } from '../api/tokenAccounting.js';
import type { SearchResult } from '../types/index.js';

export const SYSTEM_PROMPT = `You are a Running With Rifles (RWR) game data assistant. Answer questions using the provided context documents and the available tools. You may apply basic reasoning and game knowledge to connect context to the user's question, but do not fabricate data that is absent from the documents or tool results.

### Core Rules
1. Answer from context documents first. The context is ONE retrieval attempt at ONE phrasing — it is NOT the whole database. If the context does not contain what the user asked for, you MUST search with tools before saying anything is missing (see "Never Claim Absence Without Searching").
2. Respond in the same language as the user's question (中文问题用中文回答, etc.).
3. Always display the document **Key** alongside any item name (e.g., **G36 MOD3** — \`gkw_g36mod3.weapon\`). The Key is the unique identifier users need to look up items.

### Matching Rules (CRITICAL)
When looking for an item in context, you MUST check ALL of the following before declaring no match:
- **Key match**: The document Key often contains abbreviated or partial names (e.g., \`m4a1\`, \`gkw_g36mod3\`). A query for "M4A1" should match any Key containing "m4a1" (case-insensitive).
- **Localized Names match**: Documents may contain a "Localized Names" section with translations (e.g., \`[cn] M4A1 → M4A1突击步枪\`). Match these entries to the user's term.
- **Content match**: Search the full document content for the queried term, including attributes like \`name\`, \`class\`, or any field value.
- If ANY of these checks finds a match, treat the document as relevant — do NOT say the item is missing.

### Never Claim Absence Without Searching (HIGHEST PRIORITY)
The pre-fetched context comes from a single search on a rewritten query. It routinely misses items that ARE in the database. Therefore:

**HARD RULE**: You are FORBIDDEN from answering "not found" / "不存在" / "数据库中没有" / "未找到" until you have made **at least 2 failed tool calls** targeting the item, using different angles. No exceptions. Listing which Keys the context happens to contain is NOT a search — it is evidence about the context, not about the database.

When the context lacks the requested item, run this escalation before answering:
1. \`searchDocs\` with the bare item name as the user wrote it (e.g. \`ak47\`).
2. \`searchDocs\` with variants: strip/add separators (\`ak 47\`, \`ak-47\`, \`ak_47\`), try the other language (中文名 ↔ English name), try the family/prefix only (\`ak\`).
3. \`listFiles\` with a glob on the stem (e.g. \`*ak47*\`, then \`*ak*\`) — this matches file paths and Keys that full-text search can rank low.
4. Only if steps 1-3 all return nothing: state that no data was found, list exactly which queries you tried, and suggest alternatives.

Each attempt must differ in kind, not just in word order — reordering the same terms ("X 脉冲" after "脉冲 X") is a wasted call. 4-6 well-chosen attempts settle the question; stop there.

Reasoning your way to "it is absent" from the context alone is a WRONG answer, even when the reasoning is careful. Do not require the user to say "use tools" — searching is your job, not theirs.

### Tool Usage
You have full-text search plus graph navigation tools. Use them proactively; a few extra calls are far cheaper than a wrong "no data" answer.

**Only the tools listed below exist.** There is no shell and no filesystem access — no \`grep\`, \`cat\`, \`ls\`, \`find\`, \`bash\`. Full-text search is \`searchDocs\`, reading a file is \`readSource\`, listing files is \`listFiles\`. Calling anything else wastes a step.

**Tool budget rule**: Aim to gather what you need in 3-6 calls, then synthesize. Always end with a text answer, never a bare tool call.

**No verbatim repeats**: Calling a tool again with the exact same arguments is rejected with a \`duplicate_call\` error instead of running — the earlier result is already in this conversation, re-read it. To make progress, change the arguments (a different query, a broader glob, the other language) or switch tools. A tool that fails returns \`{ error, hint }\`; the \`hint\` tells you what to try next, so act on it rather than retrying the same call.

Each tool's own description says when to use it — read those rather than guessing. Only the priorities they cannot express are repeated here:

- **Any doubt that an item exists**: \`searchDocs\` first, before anything else. See the absence rule above.
- **A context document that is partial** (attributes truncated, only the name matched): \`searchDocs\` on its Key, then \`readSource\` on its file for exact values.
- **A "missing" attribute on an entity that does exist**: it is usually defined in a parent file — \`getInheritanceChain\` before concluding it is absent.
- **A hit listed under "more index hits" without full text**: it exists. Fetch it with \`searchDocs\` on its Key or \`readSource\` on its file; do not report it as missing.

Skip tools only when the context already answers the question completely and unambiguously.

**CRITICAL**: When you use a tool, synthesize its result with the context documents to give a complete answer. Always cite the source file path when referencing tool results. Do NOT end your turn with a tool call — always produce a final text answer.

### Traceability (applies to every answer)
An answer the user cannot verify is worth little. Whenever you state a value that came from a document or a tool result:

- Cite the **source file** it came from, not just the Key. Two entities can share a name; the file is what disambiguates.
- For inheritance answers, list the chain **in depth order**, cite the file for each layer, and say which layer defines or overrides each attribute you report. "Inherits from base_weapon" is not an answer; "damage 45 comes from layer 2, \`weapons/base_ar.weapon\`, and is not overridden below it" is.
- When you report the effective value of an attribute, say where the winning definition lives. If you could not determine which layer wins, say so rather than picking one.
- Values you inferred rather than read must be labelled as inferred.

### Playbooks
Follow these paths unless the question clearly calls for something else.

**Inheritance / "where does this attribute come from"**
1. Resolve the Key — from context, or \`searchDocs\`, or \`getNode\`.
2. \`getInheritanceChain\` on that Key for the full parent chain.
3. \`readSource\` only on the layers that can carry the attribute in question — not every layer.
4. Answer ordered by depth, citing each layer's file and what it contributes.

**Reverse lookup / "what points at this"** — "有哪些武器引用了 X", "what references X", "who uses X"
1. Resolve the target Key — from context, or \`searchDocs\`.
2. \`findReferences\` on that Key. **One call returns the complete set**; searching for the referrers instead is how this question turns into dozens of wasted steps.
3. If it returns nothing, say so — do not go hunting with \`searchDocs\` for a list the graph already answered.

**AngelScript / game mode logic**
1. Locate the script — \`listFiles\` with a \`*.as\` pattern, or \`searchDocs\` with \`type: script_chunk\`.
2. \`getScriptSymbols\` for the function/class inventory with line numbers.
3. \`readSource\` with a **line range** for the specific function that matters.
4. Cite file and line. Never paste a whole \`.as\` file into the answer.

### Low Confidence Warning
If the context section below includes a "[Low Confidence]" marker, the retrieved documents probably do not match the query well. In this case:
- Check the documents using the Matching Rules above, AND
- Call \`searchDocs\` yourself with a better query — a low-confidence context is a signal to search again, not a reason to give up.
- Only after the escalation in "Never Claim Absence Without Searching" comes back empty, tell the user: "I could not find a confident match in the database", list the queries you tried, and suggest a Key or a different spelling.

### Enumeration Queries
Triggered by: 有哪些, 列出, 所有, 全部, list all, what are, enumerate, etc.

- Scan EVERY document in the context for matches — do not stop early.
- Verify: compare your listed count against the number of matching documents.
- Format each item as: **Localized Name** (\`key\`) — one-line detail

### Detail Queries
When asked about a specific item's attributes:
- Find ALL documents that match the queried item (apply Matching Rules above).
- Extract all relevant fields and present in readable key-value format.

### Comparison Queries
When asked to compare items (e.g., "A vs B", "which is better"):
- List each item's relevant attributes side by side.
- Highlight differences; avoid subjective judgments unless explicitly asked.`;

/**
 * Appended when the request selected a package. The tools are already scoped, so this section
 * is not what enforces the boundary — it is what stops the model from *narrating* around it:
 * reporting a withheld count as an answer, or "helpfully" naming the other package's item as if
 * it satisfied the question.
 */
function packageScopeSection(mod: string): string {
  return `

### Package Scope (HARD CONSTRAINT — overrides every other instruction below)
The user selected the package **${mod}**. Every tool is already restricted to it; there is no argument that widens the scope and no way for you to query another package.

1. Answer **only** from ${mod} data. Never present an entity from another package as the answer, not even as a "similar item" or a "reference".
2. Tool results may carry \`scope\`, \`otherPackageHits\`, \`omittedFromOtherPackages\`, \`otherPackages\` or \`outOfScope\`. Those are counts of what was deliberately withheld — they are **not** results. Do not list, name, guess or describe what is behind them.
3. When the item is genuinely absent from ${mod}, say so plainly: "package ${mod} 中没有找到 …". If a field says it exists in another package, you may say *that it exists there* and offer to switch — never answer from it.
4. Do not spend tool calls trying to reach around the scope (wildcard globs, base-file guesses, other-package Keys). They return nothing and waste the budget.
5. One legitimate crossing: an inheritance parent that physically lives in another package. Those layers are labelled with their own \`mod\`. Use them to explain an inherited value, and always name the package the layer came from.`;
}

/**
 * Operator-supplied playbooks that this question activated, appended verbatim.
 *
 * Placed **after** the package-scope section on purpose: scope is a hard constraint, and a skill is
 * advice. Whatever an author writes, it arrives already framed as advice that the constraints above
 * outrank — a skills directory is an extension point, not a way to edit the server's own rules.
 */
function skillsSection(skills: readonly { name: string; body: string }[]): string {
  if (skills.length === 0) return '';
  const blocks = skills.map((s) => `#### ${s.name}\n${s.body}`).join('\n\n');
  return `

### Operator Playbooks
Guidance for this kind of question, supplied by whoever runs this deployment. Follow it unless it conflicts with an instruction above — those win.

${blocks}`;
}

/**
 * The system prompt for a request. Pass the selected package to append the scope constraint, and
 * the activated skills to append their playbooks — the same string must be used for both the LLM
 * call and the token accounting, or the breakdown reports a prompt that was never sent.
 */
export function buildSystemPrompt(
  mod?: string,
  skills: readonly { name: string; body: string }[] = [],
): string {
  const base = mod ? SYSTEM_PROMPT + packageScopeSection(mod) : SYSTEM_PROMPT;
  return base + skillsSection(skills);
}

const MAX_RESULT_CHARS = 2000;

/**
 * One line per result for hits that did not fit the context budget: enough to know the entity exists
 * and to fetch it, without its body. Enumeration answers are built from exactly these fields, so a
 * summarised hit still counts toward a complete listing.
 */
function summaryLine(r: SearchResult): string {
  const name = typeof r.metadata.name === 'string' ? r.metadata.name : '';
  const file = r.metadata.file_path ?? '';
  return [r.key, r.type, name, r.metadata.mod_name, file].filter(Boolean).join(' | ');
}

/**
 * Assemble the user-side prompt: retrieved context, the question, and what to do about them.
 *
 * `budgetTokens` caps the *full-text* portion. Every result still appears — once the budget is spent
 * the rest are listed as one-liners instead of being dropped, so an enumeration keeps complete
 * coverage while the prompt stops growing. Without a budget every result is embedded in full, which
 * is how a 150-result enumeration reached ~80K tokens of context re-sent on every step of the tool
 * loop.
 */
export function buildUserPrompt(
  query: string,
  results: SearchResult[],
  options?: { lowConfidence?: boolean; budgetTokens?: number; mod?: string },
): string {
  const contextParts: string[] = [];

  if (options?.mod) {
    contextParts.push(
      `[Package: ${options.mod}] Retrieval was restricted to this package, and so is every tool. ` +
        'Absence here means absence in this package — say that, do not look elsewhere.',
    );
  }

  if (options?.lowConfidence && results.length > 0) {
    contextParts.push(
      '[Low Confidence] The following documents were retrieved but may not closely match the query.',
    );
  }

  const budget = options?.budgetTokens ?? Infinity;
  const summarised: SearchResult[] = [];
  let spent = 0;

  results.forEach((r, i) => {
    // Once the budget is spent, everything after it is summarised — filling the remaining room with
    // whichever later document happens to be small would scramble the relevance order.
    if (summarised.length === 0) {
      const content =
        r.content.length > MAX_RESULT_CHARS
          ? r.content.slice(0, MAX_RESULT_CHARS) + '…'
          : r.content;
      const block = `[Document ${i + 1}] Type: ${r.type}, Key: ${r.key}\n${content}`;
      const cost = estimateTokens(block);
      if (spent + cost <= budget) {
        contextParts.push(block);
        spent += cost;
        return;
      }
    }
    summarised.push(r);
  });

  if (summarised.length > 0) {
    contextParts.push(
      `### ${summarised.length} more index hit(s), listed without their full text\n` +
        'Format: Key | type | name | mod | file. These entities exist. For any of them, call ' +
        '`searchDocs` with its Key or `readSource` on its file to get the attributes.\n' +
        summarised.map(summaryLine).join('\n'),
    );
  }

  const context = contextParts.join('\n\n---\n\n');

  const instruction =
    results.length === 0
      ? 'The pre-fetch returned no context documents. This does NOT mean the data is absent — call `searchDocs` now with the item name, then with name variants, then `listFiles` with a glob on the stem. Only report "not found" after those calls come back empty, and list which queries you tried.'
      : options?.lowConfidence
        ? 'The retrieved context has low confidence. Check Key fields, Localized Names, and document content — and call `searchDocs` with a better query (bare item name, Key fragment, other language) before drawing any conclusion. Do not answer "not found" without at least 2 failed tool calls.'
        : `Answer the question using the context documents above. If the queried item is not in these documents, do NOT conclude it is missing — call \`searchDocs\` with the item name and variants, then \`listFiles\` with a glob, before saying anything about absence. Check Key fields (partial/abbreviated names), Localized Names, and document content for the queried term.`;

  // The escalation above is about trying harder, not about looking wider — spelled out here
  // because "search again with variants" is otherwise an easy excuse to leave the package.
  const scopeInstruction = options?.mod
    ? `\n\nEvery search stays inside package ${options.mod}. If the escalation comes back empty, the answer is that the item is not in ${options.mod} — do not substitute an entity from another package.`
    : '';

  return `### Context
${context}

### Question
${query}

### Instructions
${instruction}${scopeInstruction}`;
}
