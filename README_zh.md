# Running With Rifles AI Agent

[English](/README.md)

基于 Node.js + TypeScript + Fastify 构建的 RWR 数据 RAG AI Agent，提供一次性智能问答与 OpenAI Compatible API。

## 技术栈

- **Runtime**: Node.js 20+, TypeScript
- **Web Framework**: Fastify
- **Database**: PostgreSQL + pgvector
- **ORM**: Drizzle ORM
- **Embeddings**: SiliconFlow (`BAAI/bge-m3`, 1024 维)
- **Reranker**: SiliconFlow (`BAAI/bge-reranker-v2-m3`)
- **LLM**: OpenAI Compatible API (SiliconFlow / DeepSeek / 自建)

## 项目结构

```
src/
  config/          # 配置与环境变量
  db/              # 数据库连接、schema、迁移
  ingestion/       # 数据解析与入库 CLI 脚本
  retrieval/       # RAG 检索逻辑
  api/             # Fastify 路由、OpenAI Compatible 接口
  types/           # 全局类型定义
data/              # 本地数据文件（AS/XML）
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动数据库（Docker Compose）

项目使用 PostgreSQL + pgvector 作为向量数据库。如果你已有带 pgvector 的 PostgreSQL，可跳过此步。

```bash
docker compose up -d
```

默认会启动一个 PostgreSQL 17 + pgvector 容器，暴露端口 `5432`。数据通过 Docker Volume 持久化。

### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填写数据库和 API Key
```

必填变量：
- `DATABASE_URL` — PostgreSQL 连接字符串（默认已配好 Docker Compose 连接）
- `SILICONFLOW_API_KEY` — SiliconFlow API Key
- `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` — 生成模型配置

可选变量：
- `DATABASE_TABLE` — 区分运行环境（默认：`rwr_documents`）
- `EMBEDDING_DIMENSION` / `EMBEDDING_MODEL`
- `RERANK_MODEL`
- `INGEST_BATCH_SIZE` / `INGEST_CONCURRENCY`

### 4. 初始化数据库

```bash
npm run db:migrate
```

该命令会自动创建配置的表、pgvector 扩展以及 HNSW/GIN 索引。

### 5. 导入数据

```bash
npm run ingest -- --source ./data --mod GFL_Castling
```

如需清除该 mod 的旧数据：

```bash
npm run ingest -- --source ./data --mod GFL_Castling --clear
```

如需跳过已入库的文档：

```bash
npm run ingest -- --source ./data --mod GFL_Castling --resume
```

### 6. 启动 API 服务

```bash
npm run dev
# 或
npm run build && npm start
```

服务默认运行在 `http://localhost:3000`。

## API 接口

### POST /v1/chat/completions

OpenAI Compatible 聊天接口，支持 RAG 问答。

**请求示例：**

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "G36 的伤害是多少？"}],
    "stream": false
  }'
```

**响应示例：**

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1714464000,
  "model": "deepseek-v4-flash",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "G36 的伤害是 35。" },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 120, "completion_tokens": 15, "total_tokens": 135 }
}
```

### GET /v1/models

返回可用模型列表。

### GET /health

健康检查。

## Streaming

将请求中的 `stream` 设为 `true` 可启用 SSE 流式输出：

```bash
curl -N http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "AK-47 的弹匣容量是多少？"}],
    "stream": true
  }'
```

## 数据解析

### 支持的文件类型

| 扩展名 | 类型 | 解析器 |
|--------|------|--------|
| `.weapon`, `.projectile`, `.call`, `.character`, `.xml` | XML | 通用标签驱动解析器 |
| `.as` | AngelScript | 关键字/值提取器 |
| `.ai`, `.resources`, `.name`, `.text_lines` | 纯文本 | 回退文本分块 |

### Document 结构

```ts
interface RWRDocument {
  doc_id: string;
  type: 'weapon' | 'soldier' | 'faction' | 'script_chunk' | 'projectile' | 'vehicle' | 'call' | 'character';
  key: string;
  content: string;    // 用于 embedding 的完整文本
  metadata: {
    faction?: string;
    mod_name: string;
    weapon_class?: string;
    file_path: string;
    [key: string]: unknown;
  };
}
```

## RAG 流程

1. 接收用户 Query
2. **意图解析**（类型推断、class="N" 提取、枚举检测）
3. **向量检索**（pgvector cosine distance + 元数据/内容过滤）
4. **Rerank 重排序**（bge-reranker-v2-m3 交叉编码器）
5. **构建 Prompt**（强制系统提示词 + 检索上下文）
6. 调用 LLM 生成答案

## 开发

```bash
# 开发模式（热重载）
npm run dev

# 构建
npm run build

# 格式化
npm run format

# 检查
npm run lint
```

## 部署

### Docker（推荐）

项目提供了基于 `node:24-slim` 的多阶段 `Dockerfile`。

```bash
# 构建并启动 Postgres + 应用
docker compose up -d

# 初始化数据库（只需执行一次）
docker compose run --rm app npm run db:migrate:prod

# 导入数据
docker compose run --rm app npm run ingest:prod -- --source /app/data --mod GFL_Castling

# 查看日志
docker compose logs -f app

# 停止
docker compose down
```

### 手动构建 Docker 镜像

```bash
# 构建镜像
docker build -t rwr-data-agent .

# 运行（需要外部 Postgres）
docker run -d \
  --name rwr-agent \
  -p 3000:3000 \
  --env-file .env \
  -v $(pwd)/data:/app/data:ro \
  rwr-data-agent
```

### Docker 数据库管理

```bash
# 启动数据库
docker compose up -d

# 查看日志
docker compose logs -f postgres

# 停止数据库
docker compose down

# 停止并清除数据卷
docker compose down -v
```

## 注意事项

- **强制系统提示词**：请求中的外部 `system` 消息会被忽略。服务端会注入内置的 RAG 系统提示词，防止 prompt injection 并确保行为一致。
- **单轮问答**：不维护历史会话。
- **Ingestion 为手动一次性 CLI 操作**：无后台调度。
- **Embedding 维度**：默认 **1024**（`BAAI/bge-m3`），可通过 `EMBEDDING_DIMENSION` 调整。若切换模型导致维度变化，必须先 `docker compose down -v` 清空数据库后重新迁移。
- **表名隔离**：使用 `DATABASE_TABLE` 可在不改代码的情况下区分 dev / staging / prod 环境。
