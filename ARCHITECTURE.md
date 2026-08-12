# Architecture

How a question becomes an answer, and how the local RWR game files become a searchable index.

For coding conventions and per-module notes see [`AGENTS.md`](./AGENTS.md).

---

## 1. Request pipeline

`POST /v1/chat/completions` is OpenAI-compatible on the surface; everything below the entry point is
local. No vector database, no embedding service — MiniSearch plus an entity graph, both in-process.

```mermaid
flowchart TD
    REQ["POST /v1/chat/completions<br/>messages · mod · response_format"] --> GUARD{"request size<br/>&gt; maxContextTokens × 0.7 ?"}
    GUARD -- yes --> R400["400 invalid_request_error"]
    GUARD -- no --> STRIP["drop external system messages<br/>server enforces its own SYSTEM_PROMPT"]
    STRIP --> META{"isMetaQuery?<br/>&quot;who are you&quot;"}
    META -- yes --> SKIP["skip retrieval"]
    META -- no --> INTENT["classifyQuery<br/>enumeration · comparison · specific"]

    INTENT --> SUM["session summary<br/>x-session-id, in-process Map"]
    SUM --> REWRITE["buildSearchQuery<br/>history + summary + CN↔EN synonyms"]
    REWRITE --> SEARCH["localSearch<br/>MiniSearch over key · name · i18n names · content<br/>topK 5 exact key · 12 graph-answered / reverse lookup<br/>150 enumeration · else 30"]
    SEARCH --> PROMPT["buildUserPrompt<br/>context docs + question + instructions"]

    SKIP --> MODE
    PROMPT --> MODE{"enumeration/comparison<br/>AND response_format json_object ?"}
    MODE -- yes --> SOBJ["streamObject<br/>EnumResultSchema / ComparisonResultSchema<br/>single step, no tools"]
    MODE -- no --> STXT["streamText<br/>bounded tool loop — see §2"]

    SOBJ --> OUT["NDJSON stream — see §3"]
    STXT --> OUT
```

The retrieved context is **one** search on **one** rewritten phrasing, so the system prompt forbids
answering "not found" until the model has searched with tools itself. That rule is the reason the
tool loop exists at all.

## 2. Tool loop

`streamText` drives the loop: the model thinks, calls tools, observes structured results, and repeats
until it produces a text answer or hits `stopWhen: stepCountIs(MAX_TOOL_STEPS)` (default 100). There is no free-text
`Thought:` / `Action:` protocol — the shape comes from the SDK's tool calling.

Every step re-sends the whole prompt, which is why both the shaper and the accounting exist.

```mermaid
flowchart TD
    subgraph STEP["one step"]
        direction TB
        PREP["prepareStep → toolTranscript shaper"]
        LLM["model call"]
        PREP --> LLM
    end

    LLM -- "text answer" --> DONE["finish"]
    LLM -- "tool call" --> RT

    subgraph RT["toolRuntime envelope — agent/toolRuntime.ts"]
        direction TB
        DUP{"same tool + same args<br/>earlier this request?"}
        DEADLINE["race against TOOL_TIMEOUT_MS<br/>+ request abortSignal"]
        DUP -- yes --> REJECT["error = duplicate_call, plus a hint<br/>tool never runs"]
        DUP -- no --> DEADLINE
    end

    DEADLINE --> TOOLS["8 built-in graph tools<br/>+ tools.d plugins"]
    TOOLS -- throws --> ENV["error + hint<br/>the hint names the way out"]
    TOOLS -- returns --> OK["structured result<br/>already capped at the source"]

    REJECT --> PREP
    ENV --> PREP
    OK --> PREP

    PREP -. "measured size per step" .-> ACC["tokenAccounting<br/>replay[] → per-turn breakdown"]
```

**Failures never break the stream.** A throwing tool, a timeout, an aborted request and a rejected
duplicate all leave the envelope as a `{ error, hint }` value, which reaches the model as an ordinary
tool result it can route around. The consequence for consumers: a *failed* call arrives as
`tool-result`, not `tool-error`, so success is read off the output shape (`isToolFailure`).

**Tool results are replayed in full.** The shaper only sheds them when a step's prompt would
overflow the window (`maxContextTokens × TOOL_CONTEXT_BUDGET_RATIO`, minus the system prompt, the
tool definitions and the output reservation). With the default window that effectively never happens.
When it must shed, it drops whole array items and clips long strings rather than cutting mid-JSON, so
the value stays valid JSON and carries a `_shed` note; the newest result is never touched. Blindly
compressing older results costs answer quality on multi-step enumerations, where those results *are*
the answer.

**Only the base survives the turn.** Tool calls and results live inside one turn's loop — the next
request carries only the system prompt, the tool definitions, fresh retrieved context, and the
user/assistant conversation. That is why the usage bar and the cumulative In/Out numbers are
deliberately different quantities.

## 3. NDJSON stream

Custom NDJSON, one JSON object per line keyed by `type` — not SSE.

```mermaid
sequenceDiagram
    participant C as Web UI
    participant F as Fastify
    participant M as Model
    participant T as Tools

    C->>F: POST /v1/chat/completions
    F-->>C: {"type":"turn-start","turnId":"…","protocolVersion":"1.1"}
    F->>F: search → buildUserPrompt
    F->>M: streamText(system, messages, tools)

    M-->>F: reasoning deltas
    F-->>C: {"type":"reasoning-delta"}

    M-->>F: tool call
    F-->>C: {"type":"tool-step","toolCallId":"call_1","toolName":"searchDocs","summary":"Search: ak47"}
    F->>T: execute (deduped, deadlined)
    T-->>F: result or { error, hint }
    F-->>C: {"type":"tool-step","toolCallId":"call_1","done":true,"ok":true,"durationMs":142,"summary":"12 result(s)"}

    Note over F,M: loop repeats until a text answer or the step limit

    C->>F: POST /v1/chat/steer {turnId, "只保留 class=3"}
    Note over F: queued on the turn — sticky, re-sent on every later step
    F-->>C: {"type":"steer-applied","step":3,"message":"只保留 class=3"}

    M-->>F: text deltas
    F-->>C: {"type":"text-delta"}
    F-->>C: {"type":"finish","stopReason":"completed","usage":{…,"breakdown":{…}}}
```

| Line | Meaning |
|---|---|
| `turn-start` | first line: `turnId` (the steer/stop key) + `protocolVersion` |
| `text-delta` | answer text |
| `reasoning-delta` | model reasoning, rendered separately |
| `json-delta` | partial object, structured mode only |
| `tool-step` | opening (`summary`) then closing (`done`, `ok`, `durationMs`), paired by `toolCallId` |
| `steer-applied` | a mid-stream instruction reached the loop — once per message, not per step |
| `finish` | `stopReason` (`completed` / `step-limit` / `output-limit` / `stopped`) + usage and its per-slice breakdown |
| `error` | the stream itself broke — **not** used for tool failures or stop reasons |

`finish.usage` separates **spend** from **occupancy**: `promptTokens`/`completionTokens` sum every
step of the loop, while `contextTokens` is what the next request will carry. `breakdown` attributes
the totals across system prompt, tool definitions, retrieved context, conversation, tool transcript,
reasoning, tool-call arguments and answer, listing in `exact` which figures the provider reported
verbatim rather than estimated.

## 4. Index build

Runs on boot when the index is missing or stale, and on demand via `npm run build:index`.
Staleness is decided by `INDEX_VERSION` plus a file-count and max-mtime fingerprint.

```mermaid
flowchart LR
    DIR["DATA_DIR"] --> DISC["discover packages<br/>directories with package_config.xml"]
    DISC --> PARSE["per package: parse files<br/>+ resolve languages/ i18n names"]

    PARSE --> G["output/graph.json<br/>entities · extends · fires · transforms_to"]
    PARSE --> S["output/search-index.json<br/>MiniSearch: key · name · i18n · content"]
    PARSE --> A["output/script-symbols.json<br/>AngelScript functions · classes · includes"]

    G --> TOOLS["graph tools"]
    S --> SEARCH["localSearch + searchDocs"]
    A --> SYM["getScriptSymbols"]
```

AngelScript is handled by a **symbol scanner**, not a full parser: one `script_chunk` document per
`.as` file plus extracted signatures with line numbers. Tag-shaped matching must never be applied to
`.as` files — generics like `array<Soldier>` were once misparsed as entity definitions.
