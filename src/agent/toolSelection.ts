/**
 * Progressive tool disclosure.
 *
 * The AI SDK's `prepareStep` accepts `activeTools: string[]` — "if provided, only these
 * tools are enabled/available for this step" — which narrows what the model *sees* without
 * touching the execution registry (`repairToolCall` aliases and tool execution keep the full
 * set). When the registry grows past `TOOL_DISCLOSURE_THRESHOLD`, this module picks the first
 * step's subset: the built-ins always, plus any plugin whose declared `triggers` matched the
 * query. Deterministic, no IO, no extra LLM calls.
 *
 * Everything here is a no-op while the registry fits the threshold — `selectActiveTools`
 * returns `undefined`, and the caller then omits `activeTools`, which is byte-for-byte the
 * pre-disclosure behaviour.
 */
export interface ToolDisclosureMeta {
  /** Built-in tool names — always exposed on the first step. */
  coreNames: string[];
  /** Every registered tool name (built-ins + plugins); only its length matters here. */
  allNames: string[];
  /** Tool name → normalized (trimmed, lowercased) triggers, for plugin tools that declared them. */
  pluginTriggers: Map<string, string[]>;
}

/**
 * Pick the tool names the next agent step may use, or `undefined` to keep full disclosure.
 *
 * Full disclosure (returns `undefined`) when:
 * - metadata is missing (registry not built — nothing to narrow),
 * - the threshold is `0` (disclosure disabled by config),
 * - the total tool count does not exceed the threshold (current state: a no-op),
 * - this is not the first step (`stepNumber > 0`) — once the loop is iterating the model may
 *   need any tool, and the token saving lives in the first call anyway.
 *
 * On the first step above the threshold, a tool stays exposed when any of these hold:
 * - it is a built-in (`coreNames`),
 * - it declared no `triggers` and so is absent from `pluginTriggers` — disclosure is author
 *   opt-in, and a plugin that never opted in must not vanish the moment the registry grows,
 * - one of its triggers matched the query (case-insensitive substring; CJK works because it is
 *   just string inclusion).
 *
 * Filtering `allNames` rather than concatenating keeps the registry's own order and cannot emit
 * a name that is not registered.
 */
export function selectActiveTools(
  meta: ToolDisclosureMeta | undefined,
  query: string,
  stepNumber: number,
  threshold: number,
): string[] | undefined {
  if (!meta) return undefined;
  if (threshold <= 0) return undefined;
  if (meta.allNames.length <= threshold) return undefined;
  if (stepNumber > 0) return undefined;

  const lower = query.toLowerCase();
  const triggered = new Set<string>();
  for (const [name, triggers] of meta.pluginTriggers) {
    if (triggers.some((t) => lower.includes(t))) triggered.add(name);
  }
  const core = new Set(meta.coreNames);
  return meta.allNames.filter(
    (name) => core.has(name) || !meta.pluginTriggers.has(name) || triggered.has(name),
  );
}
