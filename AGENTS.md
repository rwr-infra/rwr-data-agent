# AGENTS.md

## Project Overview

RAG AI Agent for *Running With Rifles* game data. Node.js 20+ / TypeScript / Fastify. OpenAI-compatible chat completions API with built-in retrieval. Includes a built-in chat UI served at `/`.

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
npm run extract           # CLI extraction to JSON (see below)
npm run embed             # CLI embed JSON to database (see below)
npm run ingest            # CLI extraction + embed in one step (legacy)
npm run lint              # ESLint (no config file, uses defaults)
npm run format            # Prettier (no config file, uses defaults)
```

## Running Locally (Required Order)

1. `docker compose up -d` — Postgres with pgvector
2. `cp .env.example .env` — fill in `DATABASE_URL`, `SILICONFLOW_API_KEY`, `LLM_API_KEY`
3. `npm run db:migrate` — creates table, extension, HNSW/GIN indexes
4. `npm run extract -- --source ./data --mod GFL_Castling` — extract data to JSON for review
5. `npm run embed -- --input ./extracted-documents.json` — embed JSON into database
6. `npm run dev`

## Extract CLI (Step 1: Parse → Structured JSON)

```bash
npm run extract -- --source ./data --mod GFL_Castling
npm run extract -- --source ./data --mod GFL_Castling --output ./my-data.json
npm run extract -- --source ./data --mod GFL_Castling --languages ./custom/path/languages
```

Output is a JSON file (`extracted-documents.json` by default) containing **structured documents** with:
- `type`, `key`, `label` — document identity
- `description` — natural language description generated from attributes
- `raw_text` — raw text representation
- `data` — the full parsed/resolved XML structure as JSON (for verifying inheritance, nested elements, multi-state items, etc.)
- `flat_attributes` — flattened key-value pairs for quick reference
- `metadata` — extra fields (faction, weapon_class, etc.)
- `i18n` — localized names resolved from translation files (e.g. `{"cn": {"GK-Adeline": "Adeline 艾德琳"}}`)

The extract CLI automatically discovers the `languages/` directory inside the source path or its subdirectories. Translation files (`<translation><text key="..." text="..."/>`) are loaded and matched against document `name` attributes to add localized names.

Review/edit this JSON before embedding. The `data` field contains the XML-as-JSON structure so you can verify inheritance resolution, nested elements, and multi-state items (e.g. armor transform chains).

## Embed CLI (Step 2: JSON → Database)

```bash
npm run embed -- --input ./extracted-documents.json
npm run embed -- --input ./extracted-documents.json --clear   # wipe mod first
npm run embed -- --input ./extracted-documents.json --resume  # skip existing
npm run embed -- --input ./extracted-documents.json --filter-type weapon  # only weapons
npm run embed -- --input ./extracted-documents.json --limit 10  # embed first 10 docs (testing)
```

## Ingestion CLI (Legacy: Combined Extract + Embed)

```bash
npm run ingest -- --source ./data --mod GFL_Castling
npm run ingest -- --source ./data --mod GFL_Castling --clear   # wipe mod first
npm run ingest -- --source ./data --mod GFL_Castling --resume  # skip existing
```

- **Excluded dirs**: `models/`, `maps/` (3D assets / terrain, skipped by `collectFiles`).
- **Supported extensions**: `.weapon`, `.projectile`, `.call`, `.character`, `.xml` → XML parser; `.as` → AngelScript parser; `.ai`, `.resources`, `.models`, `.name`, `.text_lines` → plain text fallback.
- **Resume dedup key**: `${type}:${key}`.
- **Batch delay**: 500ms between embedding batches to avoid rate limits (SiliconFlow).

## Architecture

### Entry Points

- `src/index.ts` — Vercel entry point. Creates app via `buildApp()`, exports the Fastify instance for Vercel Functions.
- `src/api/server.ts` — Local development entry point. Same `buildApp()` but with `app.listen()`.
- `src/app.ts` — `buildApp()` factory: registers CORS, API routes (`/v1/*`), health check, and static file serving (`public/`).

### Database Provider (Dual Driver)

`DATABASE_PROVIDER` selects the database driver at startup:

| Value | Driver | Use case |
|-------|--------|----------|
| `pg` (default) | `pg` + `drizzle-orm/node-postgres` | Local Docker, traditional servers |
| `neon` | `@neondatabase/serverless` + `drizzle-orm/neon-serverless` | Vercel + Neon |

`src/db/index.ts` uses top-level `await` to dynamically import the correct driver. The rest of the codebase (`pool.connect()`, raw SQL, Drizzle insert) works unchanged because both drivers expose the same `Pool` / query interface.

### Frontend

`public/index.html` is a self-contained chat UI (no build step). It calls `/v1/chat/completions` with `stream: true` and renders SSE chunks in real time. Served by `@fastify/static` in local dev; on Vercel, the `includeFiles` config in `vercel.json` makes it available.

### Gotchas

- **Drizzle ORM is only used for schema definition and basic queries**. Vector search and migration use **raw SQL** through the `pg` Pool because Drizzle does not support pgvector operators (`<=>`).
- **Migration is custom SQL**, not `drizzle-kit push`. `src/db/migrate.ts` runs `CREATE EXTENSION vector`, `CREATE TABLE ...`, and HNSW/GIN indexes.
- **Search has an exact-key fast path**: if the query contains `key=...` or `key: ...`, embeddings are bypassed entirely for a direct SQL lookup.
- **Query intent is hardcoded in `src/retrieval/search.ts`**: Chinese/English regex patterns infer document type (`weapon`, `soldier`, `vehicle`, etc.), detect enumeration requests, and extract `class="N"` filters.
- **External system prompts are dropped**: `chat.ts` filters out all `role: 'system'` messages from the request and enforces `SYSTEM_PROMPT` server-side.
- **Single-turn only**: no session history is maintained. Only the last user message is used for RAG.
- **Embedding content uses compact format**: `structuredDocToRWRDocument` produces content from `description` + `flat_attributes` + `i18n`, omitting the verbose `raw_text` to save ~60% storage. The full XML structure is preserved in the extracted JSON `data` field for review.

## Environment & Config

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | (required) | PostgreSQL connection string |
| `DATABASE_PROVIDER` | `pg` | `pg` for Docker/local, `neon` for Neon serverless |
| `DATABASE_POOL_MAX` | `20` | Connection pool max (Neon free tier: `10`) |
| `DATABASE_SSL` | `false` | Enable SSL (Neon requires `true`) |
| `DATABASE_TABLE` | `rwr_documents` | Table name for environment isolation |
| `SILICONFLOW_API_KEY` | (required) | SiliconFlow API key for embeddings |
| `LLM_API_KEY` | falls back to `SILICONFLOW_API_KEY` | LLM API key |
| `EMBEDDING_DIMENSION` | `1024` | BAAI/bge-m3 dimension. **Changing after data exists requires dropping the table.** |

## Vercel + Neon Deployment

1. Create a Neon database and run migration once:
   ```bash
   DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/db?sslmode=require \
   DATABASE_PROVIDER=neon DATABASE_SSL=true \
   npm run db:migrate
   ```
2. Ingest data (run locally with Neon connection string):
   ```bash
   DATABASE_URL=postgresql://... DATABASE_PROVIDER=neon DATABASE_SSL=true \
   npm run ingest -- --source ./data --mod GFL_Castling
   ```
3. Deploy to Vercel:
   ```bash
   vercel
   ```
4. Set Vercel environment variables:
   - `DATABASE_URL` — Neon connection string (with `?sslmode=require`)
   - `DATABASE_PROVIDER=neon`
   - `DATABASE_SSL=true`
   - `DATABASE_POOL_MAX=10`
   - `SILICONFLOW_API_KEY`
   - `LLM_API_KEY`

The frontend chat UI is available at the deployed root URL. The API remains at `/v1/chat/completions`.

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