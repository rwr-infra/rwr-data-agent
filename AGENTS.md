# AGENTS.md

## Project Overview

RAG AI Agent for *Running With Rifles* game data. Node.js 20+ / TypeScript / Fastify. OpenAI-compatible chat completions API with built-in retrieval.

## Critical Conventions

- **ESM only**: `"type": "module"`. All imports use `.js` extensions even for `.ts` source files. `tsconfig` uses `NodeNext` module resolution.
- **No path alias usage in practice**: `~/*` is mapped in `tsconfig.json`, but the entire codebase uses relative imports. Follow the existing style.

## Developer Commands

```bash
npm install
npm run dev              # tsx --watch src/api/server.ts
npm run build            # tsc → dist/
npm start                # node dist/api/server.js
npm run db:migrate       # raw SQL init (pgvector + table + indexes)
npm run ingest           # CLI ingestion (see below)
npm run lint             # ESLint (no config file, uses defaults)
npm run format           # Prettier (no config file, uses defaults)
```

## Running Locally (Required Order)

1. `docker compose up -d` — Postgres with pgvector
2. `cp .env.example .env` — fill in `DATABASE_URL`, `SILICONFLOW_API_KEY`, `LLM_API_KEY`
3. `npm run db:migrate` — creates table, extension, HNSW/GIN indexes
4. `npm run ingest -- --source ./data --mod GFL_Castling`
5. `npm run dev`

## Ingestion CLI

```bash
npm run ingest -- --source ./data --mod GFL_Castling
npm run ingest -- --source ./data --mod GFL_Castling --clear   # wipe mod first
npm run ingest -- --source ./data --mod GFL_Castling --resume  # skip existing
```

- **Excluded dirs**: `models/`, `maps/` (3D assets / terrain, skipped by `collectFiles`).
- **Supported extensions**: `.weapon`, `.projectile`, `.call`, `.character`, `.xml` → XML parser; `.as` → AngelScript parser; `.ai`, `.resources`, `.models`, `.name`, `.text_lines` → plain text fallback.
- **Resume dedup key**: `${type}:${key}`.
- **Batch delay**: 500ms between embedding batches to avoid rate limits (SiliconFlow).

## Architecture Gotchas

- **Drizzle ORM is only used for schema definition and basic queries**. Vector search and migration use **raw SQL** through the `pg` Pool because Drizzle does not support pgvector operators (`<=>`).
- **Migration is custom SQL**, not `drizzle-kit push`. `src/db/migrate.ts` runs `CREATE EXTENSION vector`, `CREATE TABLE ...`, and HNSW/GIN indexes.
- **Search has an exact-key fast path**: if the query contains `key=...` or `key: ...`, embeddings are bypassed entirely for a direct SQL lookup.
- **Query intent is hardcoded in `src/retrieval/search.ts`**: Chinese/English regex patterns infer document type (`weapon`, `soldier`, `vehicle`, etc.), detect enumeration requests, and extract `class="N"` filters.
- **External system prompts are dropped**: `chat.ts` filters out all `role: 'system'` messages from the request and enforces `SYSTEM_PROMPT` server-side.
- **Single-turn only**: no session history is maintained. Only the last user message is used for RAG.

## Environment & Config

- `DATABASE_TABLE` isolates environments without code changes (default: `rwr_documents`).
- `EMBEDDING_DIMENSION` defaults to `1024` (`BAAI/bge-m3`). Changing it after data exists **requires dropping the table** (data loss). No migration framework handles this.
- `LLM_API_KEY` falls back to `SILICONFLOW_API_KEY` if unset.
- Config throws at startup if `DATABASE_URL` or `SILICONFLOW_API_KEY` is missing.

## Docker

```bash
docker compose up -d                          # Postgres + App
docker compose run --rm app npm run db:migrate:prod
docker compose run --rm app npm run ingest:prod -- --source /app/data --mod GFL_Castling
docker compose down -v                        # wipe Postgres data
```

Production targets use compiled `dist/` (not `tsx`). Data directory is mounted read-only at `/app/data`.

## Testing

- **No formal test framework** (no Jest/Vitest/Mocha). `test.sh` is a single `curl` smoke test against `/v1/chat/completions`.

## Style

- Strict TypeScript (`strict: true`).
- Prefer concise, accurate responses. Use existing relative import style.
