# Running With Rifles AI Agent

[English](/README.md)

> **⚠️ 早期阶段提示**：本项目处于早期开发阶段，版本可能不稳定，随时可能发生破坏性更新。

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

数据导入分为两步：**提取**（解析 XML/游戏文件 → 结构化 JSON）然后**嵌入**（JSON → 向量数据库）。你可以在两步之间审查和编辑提取出的 JSON。

#### 第一步：提取为 JSON

```bash
npm run extract -- --source ./data --mod GFL_Castling
```

生成 `extracted-documents.json`，包含结构化文档：
- `type`、`key`、`label` — 文档标识
- `description` — 自然语言描述
- `data` — 完整的解析/继承解析后 XML 结构（可校对继承链、嵌套元素、多状态物品）
- `flat_attributes` — 扁平化键值对
- `i18n` — 从翻译文件解析的本地化名称（如 `{"cn": {"GK-Adeline": "Adeline 艾德琳"}}`）

选项：
```bash
npm run extract -- --source ./data --mod GFL_Castling --output ./my-data.json      # 自定义输出路径
npm run extract -- --source ./data --mod GFL_Castling --languages ./path/to/languages  # 自定义语言目录
```

#### 第二步：嵌入到数据库

```bash
npm run embed -- --input ./extracted-documents.json
```

选项：
```bash
npm run embed -- --input ./extracted-documents.json --clear           # 清空该 mod 旧数据
npm run embed -- --input ./extracted-documents.json --resume          # 跳过已入库文档
npm run embed -- --input ./extracted-documents.json --filter-type weapon  # 仅嵌入武器
npm run embed -- --input ./extracted-documents.json --limit 10        # 仅嵌入前 10 条（测试用）
```

#### 旧方式：一步导入

`ingest` 命令仍然可用，合并提取和嵌入为一步：

```bash
npm run ingest -- --source ./data --mod GFL_Castling
npm run ingest -- --source ./data --mod GFL_Castling --clear   # 清空旧数据
npm run ingest -- --source ./data --mod GFL_Castling --resume  # 跳过已有
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
| `.weapon`, `.projectile`, `.call`, `.character`, `.xml` | XML | 通用标签驱动解析器（含继承解析） |
| `.as` | AngelScript | 关键字/值提取器 |
| `.ai`, `.resources`, `.name`, `.text_lines` | 纯文本 | 回退文本分块 |

### 数据管线

```
XML/游戏文件 ──extract──▶ 结构化 JSON ──embed──▶ 向量数据库
                   │                        │
             （审查和编辑）           （分块 → 嵌入 → 存储）
                   │
             i18n 翻译解析
           （语言目录下的翻译文件）
```

提取出的 JSON 包含完整的解析 XML 结构（`data` 字段）、扁平化属性（`flat_attributes`）和解析后的本地化名称（`i18n`）。可编辑此文件修正解析问题后再嵌入。

### StructuredDocument 结构

```ts
interface StructuredDocument {
  type: DocumentType;
  key: string;
  label: string;
  source_file: string;
  mod_name: string;
  description: string;       // 自然语言描述
  raw_text: string;           // 原始文本表示
  data: unknown;              // 完整解析后的 XML JSON 结构
  flat_attributes: Record<string, unknown>;  // 扁平化属性
  metadata: Record<string, unknown>;
  i18n?: Record<string, Record<string, string>>;  // 本地化名称
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

# 数据库初始化
npm run db:migrate

# 提取数据为 JSON
npm run extract

# 嵌入 JSON 到向量数据库
npm run embed

# 旧方式：一步导入
npm run ingest

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

# 提取数据（第一步）
docker compose run --rm app npm run extract:prod -- --source /app/data --mod GFL_Castling

# 嵌入到数据库（第二步）
docker compose run --rm app npm run embed:prod -- --input /app/extracted-documents.json

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
- **数据导入分两步**：先 `extract` 提取为结构化 JSON（可审查编辑），再 `embed` 嵌入向量数据库。旧版 `ingest` 命令仍可用。
- **多语言支持**：提取流程自动扫描 `languages/` 目录，将翻译文件中的本地化名称解析到 `i18n` 字段，嵌入时会包含中文名供中文查询命中。
- **Embedding 维度**：默认 **1024**（`BAAI/bge-m3`），可通过 `EMBEDDING_DIMENSION` 调整。若切换模型导致维度变化，必须先 `docker compose down -v` 清空数据库后重新迁移。
- **表名隔离**：使用 `DATABASE_TABLE` 可在不改代码的情况下区分 dev / staging / prod 环境。

## 许可协议

[MIT](LICENSE) © [rwr-infra](https://github.com/rwr-infra)
