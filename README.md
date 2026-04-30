# Running With Rifles AI Agent

[中文](/README_zh.md)

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

```bash
npm run ingest -- --source ./data --mod GFL_Castling
```

To clear existing data for this mod before ingestion:

```bash
npm run ingest -- --source ./data --mod GFL_Castling --clear
```

To resume and skip already-ingested documents:

```bash
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
| `.weapon`, `.projectile`, `.call`, `.character`, `.xml` | XML | Generic tag-driven parser |
| `.as` | AngelScript | Keyword/value extractor |
| `.ai`, `.resources`, `.name`, `.text_lines` | Plain text | Fallback text chunking |

## Development

```bash
npm run dev        # dev mode (hot reload)
npm run build      # compile TypeScript
npm run db:migrate # initialize database
npm run ingest     # CLI ingestion
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

# Ingest data
docker compose run --rm app npm run ingest:prod -- --source /app/data --mod GFL_Castling

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
- **Manual ingestion**: CLI-based, no background scheduler.
- **Embedding dimension**: Default 1024 (`BAAI/bge-m3`). If you switch to a model with a different dimension (e.g., 4096), set `EMBEDDING_DIMENSION` accordingly and recreate the database (`docker compose down -v && docker compose up -d`).
- **Table isolation**: Use `DATABASE_TABLE` to separate dev / staging / prod environments without code changes.
