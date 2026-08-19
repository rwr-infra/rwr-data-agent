/**
 * `@rwr/agent-core` — the reusable half of a tool-calling data agent.
 *
 * **What is deliberately NOT here: the loop.** The AI SDK already ships one (`ToolLoopAgent`,
 * `streamText`) with `prepareStep`, `stopWhen`, `activeTools`, per-run context and tool approval.
 * Re-implementing that would mean competing with Vercel for no gain. What the SDK does *not* give
 * you is everything around the loop, and that is what this package is:
 *
 * - **steering** — reach into a turn that is already streaming, to redirect or stop it.
 * - **session** — per-session state that evicts, so a long-lived server does not leak one entry
 *   per conversation anyone ever started.
 * - **plugins** — load tool definitions an operator dropped in a directory, isolating failures.
 * - **skills** — prompt fragments injected when the question matches, so domain knowledge lives in
 *   a directory rather than in the codebase's system prompt.
 * - **reload** — the staleness bookkeeping both of those directories need, which is subtler than a
 *   `dirty` flag as soon as two loads can overlap.
 * - **transport** — the NDJSON event protocol, versioned, as a contract for external clients.
 *
 * **Architectural constraint, and the only proof that any of this is reusable: nothing in this
 * package may import a domain module.** No retrieval, no ingestion, no game-specific tools. It is
 * enforced by lint rather than by convention, because a directory that merely *looks* separate
 * gets punctured the first time someone is in a hurry.
 */
export {
  createTurn,
  steerTurn,
  stopTurn,
  endTurn,
  activeTurnCount,
  steeringLimits,
  type TurnHandle,
  type SteerResult,
} from './steering/turnRegistry.js';

export {
  createMemorySessionStore,
  type SessionStore,
  type Timestamped,
} from './session/memoryStore.js';

export {
  loadToolPlugins,
  type PluginToolSpec,
  type PluginFactory,
  type PluginEntry,
  type LoadedPlugins,
  type LoadPluginsOptions,
} from './plugins/loader.js';

export {
  loadSkills,
  selectSkills,
  type Skill,
  type SkillEntry,
  type LoadedSkills,
} from './skills/loader.js';

export { createReloadGate, type ReloadGate } from './reload/gate.js';

export {
  PROTOCOL_VERSION,
  encodeEvent,
  type AgentEvent,
  type StopReason,
  type TurnUsage,
  type TurnStartEvent,
  type PingEvent,
  type TextDeltaEvent,
  type ReasoningDeltaEvent,
  type JsonDeltaEvent,
  type ToolStepEvent,
  type SteerAppliedEvent,
  type ReflectionStartEvent,
  type ReflectionEvent,
  type RevisionEvent,
  type FinishEvent,
  type ErrorEvent,
} from './transport/events.js';
