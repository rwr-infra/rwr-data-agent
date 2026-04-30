# Running With Rifles AI Agent

基于 Node.js + TypeScript + Fastify 构建的 RWR 数据 RAG AI Agent，提供一次性智能问答与 OpenAI Compatible API。

## 技术栈

- **Runtime**: Node.js 20+, TypeScript
- **Web Framework**: Fastify
- **Database**: PostgreSQL + pgvector
- **ORM**: Drizzle ORM
- **Embeddings**: SiliconFlow (`BAAI/bge-m3`, 1024 维)
- **LLM**: OpenAI Compatible API (SiliconFlow / 自定义)

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

### 4. 初始化数据库

```bash
npm run db:migrate
```

该命令会自动创建 `rwr_documents` 表、pgvector 扩展以及 HNSW/GIN 索引。

### 5. 导入数据

```bash
npm run ingest -- --source ./data --mod vanilla
```

如需清除该 mod 的旧数据：

```bash
npm run ingest -- --source ./data --mod vanilla --clear
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
    "model": "rwr-agent",
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
  "model": "rwr-agent",
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
    "model": "rwr-agent",
    "messages": [{"role": "user", "content": "AK-47 的弹匣容量是多少？"}],
    "stream": true
  }'
```

## 数据解析

### 支持的文件类型

- `.xml` — weapon、projectile、vehicle、faction 等配置文件
- `.as` — AngelScript 脚本文件（soldier stats、behavior 等）

### Document 结构

```ts
interface RWRDocument {
  doc_id: string;
  type: 'weapon' | 'soldier' | 'faction' | 'script_chunk' | 'projectile' | 'vehicle';
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
2. 生成 Embedding（`BAAI/bge-m3`）
3. pgvector 向量相似度检索（cosine distance）
4. 元数据过滤（faction、mod_name、weapon_class 等）
5. 构建 Prompt（system prompt + context + question）
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

## Docker 数据库管理

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

- Embedding 维度默认 **1024**（`BAAI/bge-m3`），可通过 `EMBEDDING_DIMENSION` 调整
  - 若切换模型导致维度变化，必须先 `docker compose down -v` 清空数据库后重新迁移
- 单轮问答，不维护历史会话
- Ingestion 为手动一次性 CLI 操作，无后台调度
- 数据文件（`.as` / `.xml`）需自行准备并放入 `data/` 目录
