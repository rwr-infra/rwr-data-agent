# Running With Rifles AI Agent

[English](/README.md)

> **⚠️ 早期阶段提示**：本项目处于早期开发阶段，版本可能不稳定，随时可能发生破坏性更新。

一个面向 *Running With Rifles* 游戏数据的 AI Agent，回答关于武器、载具、兵种、携带物品、呼叫支援以及 AngelScript 游戏模式的问题，对外提供 **OpenAI 兼容** 的 `/v1/chat/completions` 接口，并自带聊天前端。

检索完全**在进程内、直接基于磁盘上的游戏文件**运行：MiniSearch 全文索引 + 实体关系图。不需要数据库、不需要 embedding 服务、不需要向量库。

## 技术栈

- **Node.js + TypeScript**（ESM，strict）
- **Fastify** — HTTP 服务
- **MiniSearch** — 本地全文索引（支持中文分词）
- **Vercel AI SDK** — LLM 流式输出与工具调用
- **Svelte 5 + Vite + Tailwind 4 + daisyUI** — 聊天前端
- **fast-xml-parser** — 游戏文件解析

## 快速开始

```bash
npm install
cp .env.example .env      # 填写 LLM_API_KEY
npm run dev
```

就这些。首次启动时服务会自动发现 `DATA_DIR`（默认 `./data`）下的数据包，把索引构建到 `./output`，然后在 `http://localhost:3000` 提供服务。

### 指定游戏数据目录

`DATA_DIR` 既可以是**单个数据包**（目录下有 `package_config.xml`），也可以是**装着多个包的目录**：

```bash
DATA_DIR=./data       npm run dev   # 单包：GFL_Castling
DATA_DIR=./ww2-data   npm run dev   # 5 个包：ww2_base、edelweiss、pacific…
```

包的发现规则：在根目录及其**直接子目录**中查找 `package_config.xml`。之所以不递归，是因为 `ww2_base/packages/<overlay>/` 这类子树属于 `ww2_base` 本身，不应被当成独立包。

每条文档都会打上所属包名，请求时可以限定只检索某一个包。

### 重建索引

索引缺失、或源文件发生变化（文件数或最新 mtime 改变）时会自动重建。手动强制重建：

```bash
npm run build:index                          # 使用 DATA_DIR / OUTPUT_DIR
npm run build:index -- --source ./ww2-data   # 显式指定源目录
npm run build:index -- --only ww2_base,pacific
```

设置 `AUTO_BUILD_INDEX=false` 可关闭自动构建，改为只认手动命令。

## API 接口

### POST /v1/chat/completions

OpenAI 兼容的对话接口，内置检索。

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "rwr-agent",
    "messages": [{"role": "user", "content": "class=3 的武器有哪些？"}],
    "stream": false
  }'
```

在 OpenAI schema 之外新增的字段：

| 字段 | 说明 |
|---|---|
| `mod` | 限定只检索某一个数据包（取值见 `GET /v1/packages`） |
| `response_format: {"type":"json_object"}` | 返回结构化的枚举/对比对象，而非自然语言 |

请求头：`x-session-id` 用于开启跨请求的会话滚动摘要。

> **注意**：外部传入的 `system` 消息会被丢弃 —— 服务端强制使用自己的系统提示词。

### GET /v1/packages

列出当前索引中的数据包。

```json
{
  "data_dir": "/path/to/data",
  "built_at": "2026-07-27T09:56:57.335Z",
  "packages": [
    { "name": "ww2_base", "displayName": "WW2: Base", "count": 3144 },
    { "name": "pacific",  "displayName": "WW2: Pacific Theater", "count": 128 }
  ]
}
```

### GET /v1/models

返回可用模型列表。

### GET /health

返回索引状态，不再检查任何外部依赖。

```json
{
  "status": "ok",
  "index": { "ready": true, "documents": 9861, "packages": ["GFL_Castling"], "builtAt": "…" }
}
```

### 流式输出

设置 `stream: true`。响应是 **NDJSON（按行分隔的 JSON）**，不是 OpenAI 的 SSE。每行一个对象，用 `type` 区分：`text-delta`、`reasoning-delta`、`json-delta`、`finish`、`error`。

```bash
curl -N http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"rwr-agent","stream":true,"messages":[{"role":"user","content":"G36 的伤害是多少"}]}'
```

## 架构

```
用户提问
  |
  v
意图解析        （类型推断、class="N" 提取、枚举/对比识别）
  |
  v
查询改写        （历史对话 + 会话摘要 + 中英同义词扩展）
  |
  v
本地检索        （MiniSearch，字段：key / name / 中文译名 / content，可按包过滤）
  |
  v
Prompt 构建     （强制系统提示词 + 检索到的上下文）
  |
  v
LLM 生成        （+ 7 个可被模型调用的图谱工具：继承链、反向引用、
                  转换链、读源码、按 glob 列文件、脚本符号、按 key 查节点）
```

### 索引构建

```
DATA_DIR ──发现数据包──▶ 逐包：解析文件 + 解析 languages/ 中文译名
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
          output/graph.json          output/search-index.json
          output/script-symbols.json
```

## 数据解析

### 支持的文件类型

| 扩展名 | 类型 | 解析器 |
|--------|------|--------|
| `.weapon`、`.projectile`、`.carry_item`、`.call`、`.character`、`.xml` 等 | XML | 标签驱动解析，含继承（`file=`）解析 |
| `.as` | AngelScript | 提取函数 / 类 / include 符号 |
| `.ai`、`.resources`、`.name`、`.text_lines` | 纯文本 | 兜底文本处理 |

`models/` 与 `maps/` 子树会被跳过。

### 中文检索

- 构建索引时，`resolveI18n()` 会**按包**读取该包自己的 `languages/` 目录，把译名写入索引的 `i18nNames` 字段。只索引 `cn` / `en`：其余 8 种语言的文件是 ISO-8859-1 编码，读出来是乱码，而且全部索引会稀释词频。
- `tokenize()` 把连续的中日韩字符切成**单字 + 二元组**，让「伤害」「突击步枪」这类词无需分词词典就能命中。该切分只作用于查询和短字段（`key`/`name`/`i18nNames`/`type`），**不作用于 `content`** —— 否则游戏里那些超大的本地化文本块会淹没真正的结果。中文词条不做模糊匹配和前缀匹配。

## 开发

```bash
npm run dev             # 后端，热重载
npm run web:dev         # 前端开发服务器（:5173，反代到后端）
npm run build           # tsc → dist/ 且 vite build → public/
npm run build:index     # 重建索引
npm run validate:index  # 图谱工具冒烟测试
npm run eval            # 检索评测
npm run format          # Prettier
npx tsc --noEmit        # 类型检查
```

> `npm run lint` 目前不可用：ESLint 10 要求 `eslint.config.js`，本仓库尚未提供。请用 `npx tsc --noEmit` 做检查。

## 部署

### Docker

```bash
docker compose up -d --build
```

以只读方式把 `./data` 挂到 `/app/data`，并把生成的索引持久化在 `./output`。配置从 `.env` 读取。

### Vercel

`vercel.json` 会把 `dist/`、`public/`、`output/` 打进 Serverless 函数。数据目录本身不会上传，因此索引必须在部署前构建好 —— 函数只负责加载。

## 配置

只有 `LLM_API_KEY` 是必填。完整列表见 [.env.example](./.env.example)，常用的几个：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `LLM_API_KEY` | — | **必填**，OpenAI 兼容的 API Key |
| `LLM_BASE_URL` | `https://api.siliconflow.cn/v1` | LLM 接口地址 |
| `LLM_MODEL` | `deepseek-v4-flash` | 模型名 |
| `DATA_DIR` | `./data` | RWR 数据根目录（单包或多包目录） |
| `OUTPUT_DIR` | `./output` | 索引输出目录 |
| `AUTO_BUILD_INDEX` | `true` | 启动时自动构建/刷新索引 |
| `PORT` | `3000` | HTTP 端口 |

## 许可证

见 [LICENSE](./LICENSE)。
