# Codex 交接文档 — Agent Cowork 剩余实现

> 日期: 2026-05-20
> 入口/全景: 先读 `docs/00-cowork-comparison-index.md` 第 2 节状态矩阵 + 第 3 节"关键 4 件大事"。
> 本文是给接手的编码 agent (Codex) 的自包含工单。

---

## 0. 当前状态一句话

对话流 UX 范式已对齐 Claude Cowork: 问→反问(澄清卡)→选→进度行→操作预览→内嵌审批→产物卡→追问, 外加 Composer `/模板` + `@文件` popover、真 SSE 事件流、跨会话 Memory、Runs 索引、Scheduled Tasks。后端审批/回滚/审计/runs 是长板。

关键 4 件大事里 **前 3 件已 ✅** (SSE、持久化三件套、Composer popover), 只剩第 4 件 (Tauri/React 迁移) + 收尾项。

验收基线 (必须保持绿):
```
cd "C:\Users\Administrator\Desktop\agent cowork"
node --test                       # 当前 90 通过 / 0 失败
npm run smoke:ui                  # UI 契约 + 本地操作链
```

---

## 1. ⚠️ 必读: 文件编辑陷阱

本仓库前端 `apps/windows-client/resources/app.js` 含大量中文 (多字节 UTF-8)。上一轮多次出现"编辑工具在中文字符边界把文件尾部截断"的问题。接手时:

- **每次编辑后立刻 `node --check <file>`**, 失败就说明被截断, 用 git/重写恢复。
- 编辑 `server.js` / `app.js` / `cli-runner.js` 这类含中文的大文件时, 优先用**整文件重写**或**精确锚点替换**, 不要做大段中间插入后不验证。
- 改完跑 `node --test` + `npm run smoke:ui` 双保险。
- 巡检命令 (括号配平 + 无替换字符):
```bash
node -e 'const s=require("fs").readFileSync("apps/windows-client/resources/app.js","utf8");for(const[o,c,n]of[["{","}","brace"],["(",")","paren"],["[","]","bracket"]]){const a=(s.match(new RegExp("\\"+o,"g"))||[]).length,b=(s.match(new RegExp("\\"+c,"g"))||[]).length;console.log(n,a===b?"OK":"MISMATCH")}'
grep -nP "\xEF\xBF\xBD" apps/windows-client/resources/app.js   # 应无输出
```

---

## 2. 已落地模块速查 (别重复造)

后端 (`apps/host/src/`):
- `memory/memory-store.js` — MEMORY.md 系统; 路由 `/api/memory`, `/api/memory/facts`, `/api/memory/notes[/<name>]`。Kimi API plan/chat 调用前注入。
- `runtime/runs-index.js` — `RunsIndex` (JSONL append-only + 内存重放 + `createUlid()`); 路由 `/api/runs/index`。Repository 形态。
- `runtime/cron.js` + `runtime/scheduler.js` — 零依赖 cron + 调度器; 路由 `/api/schedules` CRUD + `_tick`。默认 executor 已接 `runRecipe`。
- `runtime/run-events.js` — `RunEventBus` (seq + ring buffer + Last-Event-ID); 路由 `GET /api/runs/:id/events` (SSE)。
- `recipes/run-recipe.js` — `runRecipe()` 单一事实来源 (路由 + scheduler 共用), 发完整事件时间线, 写内嵌 events[] 的 run 记录 + 入索引。

前端 (`apps/windows-client/resources/app.js`):
- `subscribeRunEvents()` — EventSource 订阅 SSE 渲染时间线 (优雅降级)。
- `handleComposerInput` / `detectComposerTrigger` / `selectComposerPopoverItem` / `composerPopoverHandleKey` — `/模板` + `@文件` popover。
- `state.mentionedFiles` 已并入 `activeFiles()`。

测试: `apps/host/test/{memory-store,runs-index,scheduler,run-events,run-recipe,server-runtime-features}.test.js`。

---

## 3. 剩余任务 (按优先级, 每条含验收)

### P0-A 真 SQLite adapter (替换 Memory/Runs/Schedule 的文件后端)

- 背景: 三模块已是 Repository 形态接口, 现在用 JSON/JSONL 落盘。换成 SQLite, **不动调用方**。
- **建议用 Node 内置 `node:sqlite`** (Node 22.5+ 实验性, 本机 Node 22.22 可用), 维持仓库 zero-deps 约定; 若不可用再退 `better-sqlite3` (需 native build, 注意 Windows + Defender)。
- Schema 铁律 (见 `docs/kimi-cowork-scale-readiness.md` 3.2): 每表 `id TEXT PK (ULID)`, `tenant_id TEXT NOT NULL`, `created_at TEXT`, 联合索引 `(tenant_id, created_at DESC)`; 不用 SQLite 专有类型。
- 表: `runs_index`, `memory_facts`, `schedules` (+ `run_events` 可选, 替代内嵌 events[])。
- 用迁移文件管理 schema (手写 `migrations/0001_init.sql` + 一个极简 runner 即可)。
- 验收: 把 `RunsIndex` / scheduler store / memory store 各加一个 `sqlite` adapter, 通过 env 或 config 切换 (`KCW_STORE=sqlite|file`); 现有 6 个测试文件全绿不改; 新增 adapter 对等测试。

### P0-B Idempotency 收口

- 现状: 仅 `/api/file-ops/apply` 强制 `Idempotency-Key`。
- 给 `/api/recipes/:id/run` 加幂等 (同 tenant/user/key 重复请求返回缓存的 runId, 不重复产出)。复用 `server.js` 里现成的 `idempotencyStore` + `cacheKeyFor` + `sendCachedOrStore`。
- 验收: 新增集成测试 — 同 key 连发 2 次 recipe run, 第二次返回 `idempotentReplay:true` 且 runs 索引只 +1。

### P1-A Kimi Gateway 流式 + tool calls + vision (Go, `services/kimi-gateway`)

- 现状: 只有 OpenAI-compatible 非流式 chat + 重试/超时 + httptest。
- 加: SSE 流式 `POST /v1/chat/stream`; OpenAI tools schema 的 tool calls; vision (image_url multipart); 每次调用发 `llm.usage` 事件; 熔断 (`sony/gobreaker`); 多 key 轮询 + 备用 baseURL 降级。
- 验收: `go test ./...` 在 `services/kimi-gateway` 全绿 (httptest, 不依赖真实网络/密钥)。

### P1-B Audit 走 EventBus + 结构化日志

- 把现有 JSONL audit 改为 `RunEventBus`/EventBus 的一个 subscriber (不 inline 进 hot path)。
- 日志结构化 (JSON), 每行带 `trace_id` (已在 requestContext 注入, 只需贯穿到日志)。
- 验收: audit 仍落盘, 但写入路径异步; 新增测试断言 trace_id 出现在 audit 行。

### P2-A Tauri 迁移 + React 重写 (大工程, 周级)

- 决策依据见 `docs/kimi-cowork-optimization-roadmap.md` 阶段 3.1 (选 Tauri: 安装包 ~10MB, Win 仍走 WebView2, Rust 侧 wrap 现有 Go local-agent)。
- 步骤: ① React+Tailwind 重写 `apps/windows-client/resources` 的静态前端 (组件按 `docs/kimi-cowork-chat-ux-redesign.md` 第 4 节: MessageBubble/ProgressLine/PreviewCard/ApprovalActions/ArtifactCard/SourcesFooter/Composer/ClarificationCard); ② Tauri Rust 侧只做 IPC + 启动 Node host(sidecar) + 系统通知 + shell.open; ③ Node host (localhost API) 不变, 继续承担业务; ④ 旧 C/Win32 客户端归档到 `apps/windows-client-legacy`, 放弃 Defender ASR 战线。
- 验收: Tauri dev 能起窗口、加载对话流前端、跑通"发送→SSE 进度→预览→审批→产物"全链路; 打包出 < 20MB 安装器。

### P2-B `#历史 run` picker (低优先级前端)

- Composer 输入 `#` 触发, 列 `/api/runs/index` 最近 runs, 选中可"复跑"或在对话流回放 (读 run 记录 events[] 重放)。
- 验收: `npm run smoke:ui` 加断言; 手动可点。

---

## 4. 给 Codex 的即用 prompt (复制即可)

```
你接手 Agent Cowork (Windows 本地办公 Agent, Node host + 静态前端 + Go services 骨架)。
先读 docs/codex-handoff.md 和 docs/00-cowork-comparison-index.md 全文。

约束:
- 仓库 zero external deps (package.json 无 dependencies); SQLite 优先用 Node 内置 node:sqlite。
- apps/windows-client/resources/app.js 含大量中文, 编辑后必须 node --check; 出现截断立即恢复。
- 保持 `node --test` (当前 90 通过) 和 `npm run smoke:ui` 全绿; 每加一个特性补对应测试。

按 docs/codex-handoff.md 第 3 节优先级依次实现, 每完成一条:
1. 跑 node --test + npm run smoke:ui;
2. 在 docs/00-cowork-comparison-index.md 状态矩阵把对应行改 ✅ 并追加一段"本轮实现"changelog;
3. git add -A && git commit -m "feat: <简述>"。

先做 P0-A (SQLite adapter) 和 P0-B (recipe run 幂等), 完成并测试绿后停下来汇报, 再继续 P1。
```

---

## 5. 交接前最终态 (本会话结束时)

- `node --test`: 90 通过 / 0 失败。
- `npm run smoke:ui`: 通过 (含 SSE + popover 契约断言)。
- 9 个核心源文件 `node --check` 全过; app.js 2047 行, 括号配平, 无截断。
- 文档 `docs/00-cowork-comparison-index.md` 状态矩阵与 6/7/8/9 节 changelog 已同步至本会话末。
