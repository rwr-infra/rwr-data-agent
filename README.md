# Running With Rifles AI Agent

[中文](/README_zh.md)

> **⚠️ Early Stage Notice**: This project is in early development. Versions may be unstable and breaking changes can occur at any time.

A RAG AI Agent for *Running With Rifles* game data, built with **Node.js + TypeScript + Fastify**.
Provides single-turn Q&A through an **OpenAI Compatible API**.

## Stack

- **Runtime**: Node.js 20+, TypeScript
- **API Server**: Fastify
- **Vector DB**: PostgreSQL + pgvector
- **ORM**: Drizzle ORM
- **Embeddings**: SiliconFlow (`BAAI/bge-m3`, 1024d)
- **Reranker**: SiliconFlow (`BAAI/bge-reranker-v2-m3`)
- **LLM**: OpenAI Compatible API (SiliconFlow / DeepSeek / self-hosted)

## Quick Start

### 1. Install

```bash
npm install
```

### 2. Start PostgreSQL + pgvector

```bash
docker compose up -d
```

If you already have a pgvector-enabled Postgres, skip this step.

### 3. Configure

```bash
cp .env.example .env
# Edit .env and fill in API keys
```

Required variables:
- `DATABASE_URL`
- `SILICONFLOW_API_KEY`
- `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`

Optional:
- `DATABASE_TABLE` — isolate environments (default: `rwr_documents`)
- `EMBEDDING_DIMENSION` / `EMBEDDING_MODEL`
- `RERANK_MODEL`
- `INGEST_BATCH_SIZE` / `INGEST_CONCURRENCY`

### 4. Initialize Database

```bash
npm run db:migrate
```

Creates the configured table, pgvector extension, HNSW and GIN indexes automatically.

### 5. Ingest Data

Data ingestion is a two-step process: **extract** (parse XML/game files → structured JSON) then **embed** (JSON → vector database). You can review and edit the extracted JSON between steps.

#### Step 1: Extract to JSON

```bash
npm run extract -- --source ./data --mod GFL_Castling
```

This produces `extracted-documents.json` containing structured documents with:
- `type`, `key`, `label` — document identity
- `description` — natural language description
- `data` — full parsed/resolved XML as JSON (verify inheritance, nested elements, multi-state items)
- `flat_attributes` — flattened key-value pairs
- `i18n` — localized names from translation files (e.g. `{"cn": {"GK-Adeline": "Adeline 艾德琳"}}`)

Options:
```bash
npm run extract -- --source ./data --mod GFL_Castling --output ./my-data.json    # custom output path
npm run extract -- --source ./data --mod GFL_Castling --languages ./path/to/languages  # custom language directory
```

#### Step 2: Embed into Database

```bash
npm run embed -- --input ./extracted-documents.json
```

Options:
```bash
npm run embed -- --input ./extracted-documents.json --clear           # wipe mod first
npm run embed -- --input ./extracted-documents.json --resume          # skip existing
npm run embed -- --input ./extracted-documents.json --filter-type weapon  # only weapons
npm run embed -- --input ./extracted-documents.json --limit 10        # first 10 docs (testing)
```

#### Legacy: One-step Ingest

The `ingest` command still works as a combined extract+embed step:

```bash
npm run ingest -- --source ./data --mod GFL_Castling
npm run ingest -- --source ./data --mod GFL_Castling --clear
npm run ingest -- --source ./data --mod GFL_Castling --resume
```

### 6. Start Server

```bash
npm run dev
# or
npm run build && npm start
```

Default: `http://localhost:3000`

## API

### POST /v1/chat/completions

OpenAI Compatible chat completions with built-in RAG.

**Request:**

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "What weapons have class=3?"}],
    "stream": false
  }'
```

**Response:**

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1714464000,
  "model": "deepseek-v4-flash",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "The following weapons have class=3: ..." },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 120, "completion_tokens": 15, "total_tokens": 135 }
}
```

### GET /v1/models

Returns available models.

### GET /health

Health check.

### Streaming

Set `stream: true` for SSE output:

```bash
curl -N http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "What is the G36 damage?"}],
    "stream": true
  }'
```

## Architecture

```
User Query
  |
  v
Intent Parsing  (type inference, class="N" extraction, enumeration detection)
  |
  v
Vector Search   (pgvector cosine distance + metadata/content filters)
  |
  v
Rerank          (bge-reranker-v2-m3 cross-encoder)
  |
  v
Prompt Builder  (enforced system prompt + retrieved context)
  |
  v
LLM Generation  (OpenAI Compatible API)
```

## Supported File Types

| Extension | Type | Parser |
|-----------|------|--------|
| `.weapon`, `.projectile`, `.call`, `.character`, `.xml` | XML | Generic tag-driven parser with inheritance resolution |
| `.as` | AngelScript | Keyword/value extractor |
| `.ai`, `.resources`, `.name`, `.text_lines` | Plain text | Fallback text chunking |

## Data Pipeline

```
XML/Game Files ──extract──▶ Structured JSON ──embed──▶ Vector Database
                       │                          │
                 (review & edit)            (chunk → embed → store)
                       │
                 i18n resolution
                 (language/ dirs)
```

The extracted JSON contains the full parsed XML structure (`data` field), flattened attributes (`flat_attributes`), and resolved localized names (`i18n`). Edit this file to correct parsing issues before embedding.

## Development

```bash
npm run dev        # dev mode (hot reload)
npm run build      # compile TypeScript
npm run db:migrate # initialize database
npm run extract    # extract game data → JSON
npm run embed      # embed JSON → vector database
npm run ingest     # legacy: extract + embed in one step
npm run format     # Prettier
npm run lint       # ESLint
```

## Deployment

### Docker (Recommended)

A multi-stage `Dockerfile` is provided using `node:24-slim`.

```bash
# Build and start both Postgres + App
docker compose up -d

# Initialize database (run once)
docker compose run --rm app npm run db:migrate:prod

# Extract data (Step 1)
docker compose run --rm app npm run extract:prod -- --source /app/data --mod GFL_Castling

# Embed into database (Step 2)
docker compose run --rm app npm run embed:prod -- --input /app/extracted-documents.json

# View logs
docker compose logs -f app

# Stop
docker compose down
```

### Manual Docker Build

```bash
# Build image
docker build -t rwr-data-agent .

# Run (requires external Postgres)
docker run -d \
  --name rwr-agent \
  -p 3000:3000 \
  --env-file .env \
  -v $(pwd)/data:/app/data:ro \
  rwr-data-agent
```

### Docker Database Management

```bash
docker compose up -d        # start
docker compose logs -f postgres   # logs
docker compose down         # stop
docker compose down -v      # stop and wipe data
```

## Notes

- **Enforced system prompt**: External `system` messages in the request are ignored. The server injects its own RAG system prompt to prevent prompt injection and ensure consistent behavior.
- **Single-turn only**: No session history is maintained.
- **Two-step ingestion**: `extract` produces a structured JSON (reviewable/editable), then `embed` stores it into the vector database. Legacy `ingest` command still works.
- **i18n support**: The extract CLI automatically scans `languages/` directories and resolves localized names into the `i18n` field, so Chinese queries can match documents by their translated names.
- **Embedding dimension**: Default 1024 (`BAAI/bge-m3`). If you switch to a model with a different dimension (e.g., 4096), set `EMBEDDING_DIMENSION` accordingly and recreate the database (`docker compose down -v && docker compose up -d`).
- **Table isolation**: Use `DATABASE_TABLE` to separate dev / staging / prod environments without code changes.

## License

[MIT](LICENSE) © [rwr-infra](https://github.com/rwr-infra)
