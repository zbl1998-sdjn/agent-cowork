# Kimi Cowork ↔ Claude Cowork 对照体系 · 索引

> 日期: 2026-05-20
> 用途: 这一组 doc 的入口。先看本页, 再按需跳到下面 4 份详 doc。

---

## 1. 文档地图

| # | 文件 | 一句话用途 | 何时该读 |
|---|---|---|---|
| 00 | `docs/00-cowork-comparison-index.md` (本文) | 全景索引 + 当前状态合并视图 + 下一步去哪一份 | 开头总览 / 不知道下一步该做什么 |
| 01 | `docs/kimi-vs-claude-cowork-gap.md` | 三维度差距分析 (UX / 功能 / 架构) + 优势 + 优先级建议 | 想知道 "差什么 / 为什么差" |
| 02 | `docs/kimi-cowork-optimization-roadmap.md` | 5 阶段优化路线 + 具体步骤 + 时间估 | 排期 / 把差距翻译成 task |
| 03 | `docs/kimi-cowork-scale-readiness.md` | 单机本地 → 100k DAU → 1M DAU 不重写的架构准备 | 改 schema / 加新服务前必看 |
| 04 | `docs/kimi-cowork-chat-ux-redesign.md` | dashboard → 对话流范式迁移 + 组件库 + SSE 协议 | 改前端、改 Composer、改 SSE 时 |
| 05 | `docs/cowork-next-30-days.md` | 下一个 30 天 sprint 的可执行清单 (替代已完成的旧 30 天最小路径) | 排下一步活 |
| 06 | `docs/codex-handoff.md` | 给接手编码 agent 的自包含工单 (剩余任务 + 验收 + 即用 prompt) | 交接 / 继续开发 |

辅助上游 (Kimi 团队既有):

- `plan/kimi-cowork-latest-product-plan-v0.3.md` — 产品规划基线 (v0.3)
- `docs/v0.3-implementation-status.md` — Kimi 团队自维护的实现状态
- `docs/merged-execution-baseline.md` — 执行基线
- `docs/mvp-1-windows-c-cloud-architecture.md` — MVP-1 云端架构
- `docs/open-cowork-reference-improvements.md` — 借鉴 open-cowork 的方向 (Tauri/React/MCP)

---

## 2. 当前状态全景 (2026-05-21 合并视图)

以下表格把 4 份 doc 各自的"本轮实现状态"汇总成一个矩阵。状态符号:

- ✅ 已落地 (有代码 + smoke 覆盖)
- 🟡 部分落地 (有 MVP, 仍有差距)
- ❌ 未做

### 2.1 UX 原语 (对应 doc 01 第 1 节 / doc 04)

| 能力 | 状态 | 说明 |
|---|---|---|
| 对话流主区 (conversation timeline) | 🟡 | 静态 HTML/CSS/JS 版已上, 已补 Tauri/React 组件迁移清单; 真实 React 运行时仍待接入 |
| 用户/Assistant 气泡 | ✅ | message bubble controller 已落地 |
| 进度行 (ProgressLine) | ✅ | 前端已接 `EventSource` 订阅 SSE, 由服务端权威事件流驱动 (老 webview 无 EventSource 时降级到同步渲染) |
| SSE event stream | ✅ | 后端 `GET /api/runs/:id/events` (RunEventBus + Last-Event-ID + 持久 events[] 重放) + **前端 `app-run-events.js` 的 `subscribeRunEvents` 用 EventSource 实接**; recipe 流发 user_message→assistant_start→progress→preview→awaiting_approval→sources→assistant_end |
| 操作预览卡 (PreviewCard) | ✅ | 内嵌气泡, 跟随对话流 |
| 审批按钮 (ApprovalActions) | ✅ | 内嵌, 不再固定面板 |
| 产物卡 (ArtifactCard) | ✅ | 跟着对话气泡走 |
| 来源页脚 (SourcesFooter) | ✅ | 显示来源文件 + 摘录 |
| 澄清气泡 (ClarificationCard) | ✅ | MVP 版双轨展示 |
| Composer `/` 模板 picker | ✅ | `/` 触发模板 popover (键盘上下选 + Enter/Esc), 选中插入模板 prompt + 设 selectedRecipeId; controller 已拆到 `app-composer-popover.js` |
| Composer `@` 文件 mention | ✅ | `@` 触发文件 popover, 走 `/api/files/search` 实时检索, 选中插入 `@文件名` 并加入 `state.mentionedFiles` 供模板/计划引用; controller 已拆到 `app-composer-popover.js` |
| Composer `#` 历史 run picker | ✅ | `#` 触发历史任务 popover, 走 `/api/runs/index` 列最近 runs; 选中后读取 `/api/runs/:id`, 回放 run record 的 `events[]`, 并把原 prompt 放回 Composer 便于复跑; controller 已拆到 `app-composer-popover.js` |
| 任务状态 Badge | 🟡 | 任务卡片在, 但消息头部 badge 仍简化 |
| computer:// 等价一键打开 | ❌ | 产物卡有路径, 缺 shell open 集成 |
| 内联可视化 widget (Chart/Mermaid) | ❌ | 未做 |
| 持久 HTML Artifact (活页) | ❌ | 产物仍是死文件 |

### 2.2 功能 / 工具 (对应 doc 01 第 2 节 / doc 02 阶段 1-4)

| 能力 | 状态 | 说明 |
|---|---|---|
| 文件树 + trusted root + path policy | ✅ | 长板, 比 Claude Cowork 更严; 所有请求传入的 `trustedRoot` 都先夹在 host 配置根内, 禁止用 body 覆盖逃逸 |
| Preview / Apply / Rollback / Audit | ✅ | 长板, no-overwrite/no-delete 已锁; `/api/file-ops/apply` 现在强制 JSON + 本地 Origin + Idempotency-Key, 且同 key 不同 body 返回 409 |
| DOCX/XLSX/PPTX 抽取 | 🟡 | `/api/files/extract` MVP, 不含 OCR / 复杂表格恢复 |
| PDF 抽取 | 🟡 | 仅基础文本, 无 fill/sign/表单/OCR |
| 真实模板 (会议纪要 / Excel 清洗 / 报销) | ✅ | 3 个端到端通; 8 入口都在 `/api/recipes` |
| Recipe 注册表 | ✅ | `/api/recipes` + `/api/recipes/:id/run`; recipe run 强制 Idempotency-Key, 同 tenant/user/key/body replay, 不同 body 409, 不重复产出 run |
| 文件卡片 (`present_files` 等价) | 🟡 | 卡片在, 缺系统级一键打开 |
| Kimi CLI 集成 | ✅ | 长板, runs/*.json 审计级落盘 |
| Kimi Gateway (OpenAI-compatible chat) | ✅ | 非流式 + 重试 + 超时, 已 httptest 覆盖 |
| Kimi Gateway 流式 / tool calls / vision | ✅ | `services/kimi-gateway` 已支持 `ChatStream`、`POST /v1/chat/stream` SSE handler、OpenAI tools/tool_calls、multipart `image_url` vision、`llm.usage` 事件、多 key/baseURL fallback、熔断；client 已拆成 types/breaker/parser/stream handler, 并补齐 stream `[DONE]`、multipart limit、content part、错误泄漏回归测试 |
| MCP 客户端 | ❌ | 0 实现, 仍在 plan v0.3 V1 阶段 |
| 外部 SaaS 连接器 (Slack/Notion/Gmail/...) | ❌ | 0 实现 |
| 工具懒加载 (ToolSearch 等价) | ❌ | 当前全暴露 |
| Scheduled Tasks | ✅ | `apps/host/src/runtime/scheduler.js` + cron 解析器 (零依赖); `/api/schedules` CRUD + `_tick`; cron + 一次性; tenant 隔离; create/cancel/delete/_tick 均强制 Idempotency-Key, 手动 tick 只触发当前 tenant; 默认 executor 已接 `runRecipe` 真正产出可审批产物 + 入索引; 文件 store + SQLite store adapter |
| Memory 跨会话 (MEMORY.md) | ✅ | `apps/host/src/memory/memory-store.js`; `/api/memory` + facts/notes; Kimi CLI plan/chat 调用前自动注入; 文件 store + SQLite facts/notes adapter; SQLite 写入同样落 memory audit |
| Runs 索引 (Repository 形态) | ✅ | `apps/host/src/runtime/runs-index.js` JSONL append-only file adapter + `SqliteRunsIndex`, ULID 主键, tenant 隔离, `/api/runs/index`; legacy `/api/runs`、`/api/tasks`、`/api/runs/:id/events` 也已按 tenant 收口 |
| SQLite 持久化 | ✅ | `KCW_STORE=sqlite` / `storeBackend:'sqlite'` 可切 Memory facts/notes、Runs index、Schedules 到 Node 内置 `node:sqlite`; schema 走 `apps/host/src/storage/migrations/0001_init.sql`, migration 逐文件事务化 |
| 浏览器 Agent | ❌ | smoke:rendered-ui 是工程内用, 没产品化 |
| Windows OS 自动化 MCP | ❌ | 客户端骨架在, 未对外暴露 |
| 子 Agent / Plan mode 产品化 | ❌ | 状态机有, 缺前台呈现 |
| Sources 引用规范 | ✅ | 模板产物末尾 + 气泡页脚 |

### 2.3 底层架构 / Scale 地基 (对应 doc 03)

8 条不可逆地基的当前态:

| # | 地基 | 状态 | 说明 |
|---|---|---|---|
| 1 | tenant_id / user_id / trace_id / version | 🟡 | Host API 已注入 + 响应头返回; runs-index / scheduler / memory 三个新模块都按 tenant 隔离 + version 乐观锁; Node 侧默认值仍是 `tenant_local`/`user_local` (待 Phase B auth 填真值) |
| 2 | ULID/UUIDv7 主键 (不用自增 INT) | 🟡 | Go domain 有 ULID 工厂; Node 侧 `runs-index.js` 已加 `createUlid()` (Crockford base32, 时间前缀可排序), schedule id 用 `sched_` 前缀 ULID; 旧 runs/*.json 仍用 timestamp runId |
| 3 | Ports & Adapters | 🟡 | Go 侧 Port 接口已定 (Repository/LLMClient/SandboxPort/BlobStore/EventBus/JobQueue); Node host 仍直接读写 fs |
| 4 | Idempotency-Key 关键写接口 | ✅ | `/api/file-ops/apply`、`/api/recipes/:id/run`、`/api/schedules` create/cancel/delete/_tick 已强制; cache key 绑定 tenant/user/path/key + body fingerprint, 同 key 不同 body 409 |
| 5 | Schema migration 工具 | ✅ | `apps/host/src/storage/sqlite.js` 极简 migration runner + `migrations/0001_init.sql`; 每个 migration 文件在 `BEGIN IMMEDIATE` 事务内执行并记录 |
| 6 | 文件路径不进业务表 (blob_id + CAS) | ❌ | runs/*.json 还在用路径字段 |
| 7 | Audit 走 EventBus 异步 | ✅ | `AuditEventBus` + JSONL subscriber 已落地; memory audit 不再 inline 同步写 hot path, SQLite memory 写入同样发 audit, `flush` 会暴露 subscriber failure |
| 8 | trace_id 贯穿日志和 metric | 🟡 | trace_id 已注入并返回; audit JSONL 已结构化输出 `trace_id`/`tenant_id`/`user_id`, metric 仍未做 |

### 2.4 验收 / 工程

| 能力 | 状态 | 说明 |
|---|---|---|
| `npm run smoke:ui` (UI 契约 smoke) | ✅ | 通过 |
| `npm run smoke:rendered-ui` (真实浏览器 smoke) | ✅ | 通过, 覆盖 1536×900 + 1366×768 + 上传 + 审批 |
| `npm run smoke:live-mvp` | ✅ | 通过 |
| `npm run smoke:kimi-cli` | ✅ | 通过 (依赖本机 Kimi CLI) |
| `npm run verify:windows-readiness` | ✅ | 只读诊断, 不修改 Defender |
| `npm run audit:mvp` | ✅ | 聚合验收, Web/Host MVP 就绪 |
| Tauri desktop scaffold | ✅ | `apps/windows-client/src-tauri` 已有 Tauri v2 配置、Rust command 入口、packaged sidecar 契约、safe opener、CSP、Node host dev 启动脚本、组件迁移清单和 scaffold smoke; 当前机器缺 `cargo`/`rustc`/`cargo tauri`, 尚不能验收 dev 窗口/安装器 |
| Windows 原生客户端 GUI smoke | 🟡 | C/Win32 + WebView2 仍保留作 legacy 参考, 但 Defender ASR 仍卡 KimiCowork.exe; 新主线转向 Tauri scaffold |

---

## 3. 当前阶段一句话

**Kimi Cowork 已经走过 "PoC + 单一 dashboard" 阶段, 进入 "对话流 MVP + 真实模板"**。本地审批/回滚/审计/runs 这套长板还在; UX 原语已覆盖 SSE、Composer `/`/`@`/`#`、Memory/Schedule/Runs SQLite adapter、Kimi Gateway 流式/tool/vision、audit EventBus 和关键本地 API 安全边界; 但 **MCP 生态、真实 React runtime、Tauri dev/window/installer、HTML Artifact 活页** 仍是后续主线。

距离 "像 Claude Cowork" 的关键 4 件大事 (按 ROI 排):

1. ~~**真 SSE event stream**~~ ✅ 后端 + 前端 EventSource 全通; 伪流式已被服务端权威事件流取代。
2. ~~**SQLite + MEMORY.md + Scheduled Tasks**~~ ✅ 三件运行时模块已落地 (Repository 形态 + SQLite adapter)。
3. ~~**Composer `/模板` + `@文件` + `#历史` popover**~~ ✅ 已落地。
4. **Tauri/Electron 迁移 + React 重写** (退出 C/Win32 + Defender ASR 战线) — Tauri scaffold / 组件契约 / sidecar + safe opener 契约已落地; 完整 dev 窗口 + 打包验收受本机缺 Rust/Tauri 工具链阻塞。

下一步聚焦: (a) 安装/接入 Rust + Tauri CLI 后完成 dev 窗口和安装器验收; (b) 把静态 DOM helper 迁到真实 React runtime; (c) MCP 客户端和 HTML Artifact 活页。

具体可执行清单 → `docs/cowork-next-30-days.md`。

---

## 4. 阅读路径建议

| 你想干 | 先看 | 再看 |
|---|---|---|
| 整体盘一眼 | 本文 | (够了) |
| 给老板/团队解释为什么差 | 01 gap | 本文第 2 节 |
| 排下一个 sprint | 05 next-30 | 02 roadmap (中长期) |
| 改前端 / 改 SSE | 04 UX | 02 roadmap 阶段 0 |
| 改后端架构 / 加新服务 | 03 scale | 02 roadmap 阶段 3 |
| 决定该不该接某个外部依赖 | 03 scale 反模式 | 02 roadmap 阶段 3-4 |
| 想知道 Kimi 现在什么是亮点 | 01 gap 第 4 节 (优势) | 本文 2.3 长板 |

---

## 5. 文档维护约定

- 4 份 doc 的"本轮实现状态"段保留, 每完成一批就追加, 不删历史 — 它们是项目级 changelog。
- 本索引 (00) 的状态矩阵 (第 2 节) 应该跟 4 份 doc 的"本轮实现状态"段同步, 是单一事实表。
- 当 4 份 doc 之间出现冲突 (例如 UX redesign 里写"还是 dashboard"但其实已经改成对话流), 以本索引为准, 然后回头修该 doc。
- 新增任何架构性决策, 先更 doc 03 scale-readiness 再编码, 不要"先写代码再补 doc"。
- 完成阶段时, 把对应阶段的时间估 `估时: X 天` 改成 `✅ 已完成 (PR/commit ref)`。

---

## 6. 2026-05-20 本轮实现 (Memory + Runs Index + Scheduler)

按本索引第 3 节"下一个 4 件大事"里的第 2 件 (SQLite + MEMORY.md + Scheduled Tasks), 本轮落地了三个零依赖、Repository 形态的运行时模块, 全部 tenant 隔离 + version 乐观锁, 便于 Phase B 平滑换 SQLite/Postgres adapter。

已落地:

- **MEMORY.md 系统** (`apps/host/src/memory/memory-store.js`):
  - `/api/memory` (读全文 + notes 列表 + 限额), `/api/memory/facts` (追加事实, 走 Idempotency 上下文), `/api/memory/notes` (写笔记), `/api/memory/notes/<name>` (读笔记)。
  - Kimi CLI `plan`/`chat` 调用前自动注入 MEMORY.md 前 4KB 作为 system 段 (`buildMemoryBlock`)。
  - 所有写操作落 `.KimiCowork/audit/memory.jsonl`, 带 trace/tenant/user。
  - UTF-8 安全裁剪 + 路径策略校验 (note 名 whitelist, 防 `../` 逃逸)。
  - 10 个单测覆盖。
- **Runs 索引** (`apps/host/src/runtime/runs-index.js`):
  - `createUlid()`: Crockford base32, 毫秒时间前缀, 可排序, 全局唯一 (对齐 scale-readiness 地基 #2)。
  - `RunsIndex`: JSONL append-only 事件日志 + 内存 Map 重放, `upsert/get/list/remove/stats`, tenant 隔离, version 自增。
  - `/api/runs/index`: 按 tenant 范围列出 + stats; recipe-run / kimi-plan / kimi-chat 成功失败都自动 upsert。
  - 8 个单测覆盖。
- **Scheduled Tasks** (`apps/host/src/runtime/cron.js` + `scheduler.js`):
  - 零依赖 5 字段 cron 解析器 (`*`, 范围, 步进, 列表, dom/dow 经典 OR 语义) + `nextFireAt` + `describeCron` 中文友好提示。
  - `Scheduler`: 文件落盘, 低频 tick (默认 30s, unref), cron + 一次性 fireAt, `create/list/get/cancel/remove/pickDue/tickOnce`, tenant 隔离, executor 注入。
  - `/api/schedules` GET/POST, `/api/schedules/<id>/cancel`, `DELETE /api/schedules/<id>`, `/api/schedules/_tick` (手动触发, 便于测试)。
  - 默认随 host 自启动 (可 `enableScheduler:false` / `startScheduler:false` 关闭)。
  - 12 个单测 + 6 个 server 集成测试覆盖。

验收:

- `node --test` 全量 **75 通过 / 0 失败** (基线 49 → 本轮 +26 含 1 个 server 集成文件)。
- 手动 boot check: `/health`、`/api/memory`、`/api/runs/index`、`/api/schedules` 均 200, trace_id 注入正常, scheduler 自启动且 unref 不阻塞退出。

仍未做 (下一批):

- 真 SSE event stream (`GET /api/runs/:id/events`) 替换前端伪流式 — 第 3 节第 1 件大事。
- Memory / Runs / Schedule 换真 SQLite adapter (接口已就位)。
- 持久 HTML Artifact (活页), Composer `/`+`@` popover, Tauri/Electron 迁移。
- scheduler 默认 executor 仍是 noop; 需接 recipe runner 让定时任务真正产出可审批产物 (executor 注入点已留)。

---

## 7. 2026-05-20 本轮实现 (SSE event stream + event-sourced runs + scheduler executor)

接续第 6 节, 本轮把"真 SSE 事件流"(第 3 节第 1 件大事的后端部分) 和"让定时任务真正产出产物"落地。

已落地:

- **进程内事件总线** (`apps/host/src/runtime/run-events.js`):
  - `RunEventBus`: 每个 run 单调 `seq`, 有界 ring buffer (默认 500) 供重放, `publish/subscribe/replay/seed`。
  - `formatSseFrame` (id/event/data 三行帧), `parseLastEventId`。
  - 对齐 scale-readiness 的 EventBus port; Phase B 可换 NATS/Redis pub-sub, `seq=Last-Event-ID` 契约不变。
- **可复用 recipe 执行器** (`apps/host/src/recipes/run-recipe.js`):
  - `runRecipe(...)` 是 recipe 执行的单一事实来源, 路由和 scheduler 都调它。
  - 发完整事件时间线: `user_message → assistant_start → progress → preview → awaiting_approval → sources → assistant_end`。
  - 写 run record (内嵌 `events[]`, 支持重启后重放) + 自动入 runs 索引。
- **SSE 端点** (`GET /api/runs/:id/events`):
  - `text/event-stream`, 先重放持久 `events[]` (按 `Last-Event-ID` 过滤) + buffer, 再订阅实时事件; 15s 心跳 (unref); 断连自动清理。
- **Scheduler 默认 executor 接通 recipe**:
  - 定时任务 payload 带 `recipeId` 时, 默认 executor 调 `runRecipe` 真正产出可审批产物 + 入索引 + 发事件; 不再是 noop。
- **recipe 路由重构**: `POST /api/recipes/:id/run` 改为委托 `runRecipe`, 逻辑去重, 行为不变 (响应多带 `events`)。

验收:

- `node --test` 全量 **90 通过 / 0 失败** (上一轮 75 → 本轮 +15: 8 run-events + 3 run-recipe + 4 集成 SSE/scheduler)。
- 集成测试覆盖: SSE 回放完整时间线、`Last-Event-ID` 跳过已送事件、非法 runId 返回 400、scheduler 一次性任务真跑 recipe 并入租户索引。

仍未做 (下一批, 已按 ROI 排在第 3 节):

- 前端接 `EventSource` 订阅 SSE, 替换当前伪流式 DOM 追加。
- Composer `/模板` + `@文件` popover。
- Memory / Runs / Schedule 换真 SQLite adapter (接口已就位)。
- Tauri/Electron 迁移 + React 重写。

---

## 8. 2026-05-20 本轮实现 (前端 EventSource 接 SSE)

第 3 节第 1 件大事 (真 SSE) 的前端临门一脚已完成 — 伪流式 DOM 追加换成由服务端权威事件流驱动。

已落地:

- **`subscribeRunEvents(message, runId)`** (`apps/windows-client/resources/app.js`):
  - 用 `new EventSource('/api/runs/<id>/events')` 订阅 SSE, 按事件类型 (`progress`/`preview`/`awaiting_approval`/`sources`/`assistant_end`) 把时间线渲染进对话气泡。
  - 按 `seq` 去重; `assistant_end` 或 error 时自动 `close()`, 防止重连风暴。
  - 优雅降级: `typeof EventSource === 'undefined'` (老 webview) 时返回 null, 调用方回退到原同步渲染。
- **`runRecipePlan` 接入**: 拿到 `runId` 后优先 `subscribeRunEvents` 驱动实时时间线, 仅在 EventSource 不可用时用同步 summary 兜底。
- **Composer 收口**: send 按钮改回 `handleComposerSend()` (chat / cowork 正确分流), 补 Enter 发送 / Shift+Enter 换行。
- **new-chat 清理**: 新建会话时关闭活跃 EventSource (`state.activeEventSource`)。

验收:

- `npm run smoke:ui` 通过, 新增 3 条 SSE 契约断言 (`function subscribeRunEvents`, `new EventSource(`, `/events\`` 路由)。
- `node --test` 全量 **90 通过 / 0 失败** (后端无回归)。
- `node --check apps/windows-client/resources/app.js` 语法通过 (1862 行)。

工程备注:

- 本轮多次遇到 Edit/Write 在中文多字节字符处截断 app.js 的环境问题; 已改用 bash/python 直接落盘并每步 `node --check` 兜底, 文件已恢复完整。

仍未做 (下一批):

- Composer `/模板` + `@文件` + `#历史` popover。
- Memory / Runs / Schedule 换真 SQLite adapter (Repository 接口已就位)。
- Tauri/Electron 迁移 + React 重写; Kimi Gateway 流式 / tool calls / vision; MCP 客户端。

---

## 9. 2026-05-20 本轮实现 (Composer slash/at popover)

第 3 节第 3 件大事 (Composer popover) 完成 — 把"任务模板"从顶部卡片、"文件"从右侧列表收进对话输入框, 对齐 Claude Cowork 的 `/` 和 `@` 交互。

已落地:

- **`/模板` popover**: 输入行首 `/` 触发, 实时按名称/摘要过滤 `state.recipes`; ↑↓ 选择, Enter 确认, Esc 关闭; 选中后插入模板 prompt 并设 `selectedRecipeId` (来源标 `slash`)。
- **`@文件` mention popover**: 输入 `@关键词` 触发, 走 `/api/files/search` (带防抖 token, 过期结果丢弃); 选中插入 `@<文件名>` 并把文件加入 `state.mentionedFiles`, `activeFiles()` 已优先纳入, 让随后的模板/计划自动引用该文件。
- **键盘整合**: composer keydown 先问 `composerPopoverHandleKey` (popover 开时 Enter 选条目而非发送), 再走 Enter 发送 / Shift+Enter 换行; blur 延迟关闭以兼容 mousedown 选择。
- **样式**: `app.css` 新增 `.composer-popover` (绝对定位于输入框上方, 滚动, 高亮 active 项)。

验收:

- `node --test` 全量 **90 通过 / 0 失败**。
- `npm run smoke:ui` 通过, 新增 3 条断言 (`function handleComposerInput`, `detectComposerTrigger`, `class="composer-popover"`)。
- `node --check apps/windows-client/resources/app.js` 通过 (2047 行)。

至此 index 第 3 节"关键 4 件大事"前三件 (SSE / 持久化三件套 / Composer popover) 全部 ✅; 仅剩第 4 件 **Tauri/Electron + React 迁移** 这一大工程, 以及把文件后端换真 SQLite adapter。

仍未做 (下一批):

- `#历史 run` picker (优先级低)。
- Memory / Runs / Schedule → SQLite adapter。
- Tauri/Electron 迁移 + React 重写; Kimi Gateway 流式 / tool calls / vision; MCP 客户端。

---

## 10. 2026-05-21 本轮实现 (SQLite adapters)

P0-A 完成 — Memory / Runs Index / Scheduler 仍保留默认 file backend, 同时新增真 SQLite adapter, 通过 `KCW_STORE=sqlite` 或 `createServer({ storeBackend: 'sqlite', sqliteDbPath })` 切换, 调用方接口保持一致。

已落地:

- **SQLite migration runner** (`apps/host/src/storage/sqlite.js` + `apps/host/src/storage/migrations/0001_init.sql`):
  - 懒加载 Node 内置 `node:sqlite`, 保持仓库 zero external deps。
  - `schema_migrations` 管理手写迁移。
  - `runs_index` / `memory_facts` / `memory_notes` / `schedules` 均使用 `id TEXT PRIMARY KEY`, `tenant_id TEXT NOT NULL`, `created_at TEXT`, 并建立 `(tenant_id, created_at DESC)` 索引。
- **Runs Index SQLite adapter** (`SqliteRunsIndex`):
  - 保持 `upsert/get/list/remove/stats/size` 接口, tenant/user/status/type/recipe 过滤语义与文件 adapter 对齐。
- **Memory SQLite adapter** (`SqliteMemoryStore`):
  - facts/notes 走 SQLite, 按 tenant 隔离; `loadMemoryContext` 仍输出原 MEMORY.md 风格文本块, 供 Kimi CLI 注入。
- **Scheduler SQLite store** (`SqliteScheduleStore`):
  - `Scheduler` 改为 store adapter 形态, 默认 file store 行为不变; SQLite store 支持跨实例重放 schedules。
- **Server 切换**:
  - 默认仍 `file`; 设置 `KCW_STORE=sqlite` 或配置 `storeBackend:'sqlite'` 后, Memory / Runs Index / Schedules 共用 `sqliteDbPath`。

验收:

- `node --test` 全量 **94 通过 / 0 失败** (新增 4 条 SQLite adapter/config 测试)。
- `npm run smoke:ui` 通过。

仍未做 (下一条 P0-B):

- `/api/recipes/:id/run` Idempotency-Key 缓存复用, 保证同 tenant/user/key 重复请求不重复产出 run。

---

## 11. 2026-05-21 本轮实现 (Recipe run idempotency)

P0-B 完成 — `/api/recipes/:id/run` 复用 server 现有 `idempotencyStore` / `cacheKeyFor` / `sendCachedOrStore`, 同 tenant/user/path/key 的重复 recipe run 直接返回首个响应缓存, 不再重复调用 `runRecipe`、不重复生成 run record、也不重复写 runs index。

已落地:

- **Recipe run replay** (`apps/host/src/server.js`):
  - 首次请求正常执行 recipe 并缓存完整响应。
  - 重复 `Idempotency-Key` 请求返回相同 `runId` + `idempotentReplay:true`。
  - 未提供 key 时保持原行为, 不强制拒绝。
- **集成测试** (`apps/host/test/server-runtime-features.test.js`):
  - 同 key 连发 2 次 `/api/recipes/meeting-actions/run`, 第二次 replay。
  - `/api/runs/index` 断言仍只有 1 条 run, stats.total 仍为 1。

验收:

- `node --test` 全量 **95 通过 / 0 失败**。
- `npm run smoke:ui` 通过。

P0 阶段当前状态:

- P0-A SQLite adapter ✅
- P0-B recipe run 幂等 ✅

---

## 12. 2026-05-21 本轮实现 (Kimi Gateway stream/tools/vision)

P1-A 完成 — `services/kimi-gateway/internal/kimi` 从非流式 OpenAI-compatible chat client 扩展为可流式、可工具调用、可 vision 输入、可多 key/baseURL fallback 的 gateway 内核, 全部用 httptest 覆盖, 不依赖真实网络或真实密钥。

已落地:

- **SSE 流式**:
  - `Client.ChatStream(ctx, request, emit)` 调 Kimi OpenAI-compatible `/chat/completions` 并解析 `data:` SSE chunk。
  - 解析 delta content、tool_call、usage 和 `[DONE]`。
  - `NewStreamHandler(client)` 暴露 `POST /v1/chat/stream`, 输出本地 SSE 事件。
- **Tool calls**:
  - `ChatRequest.Tools` / `ToolChoice` 支持 OpenAI tools schema。
  - 非流式 response 解析 `tool_calls`, 允许 assistant content 为空但有 tool call。
- **Vision multipart**:
  - `POST /v1/chat/stream` 支持 `multipart/form-data` 的 `model` / `prompt` / `image_url` 字段, 转成 OpenAI content parts (`text` + `image_url`)。
- **Usage 事件**:
  - upstream usage chunk 转成本地 `event: llm.usage`。
- **多 key + fallback + 熔断**:
  - `Client.APIKeys` / `Client.BaseURLs` 按 retry attempt 轮询。
  - retryable 失败会切下一个 key/baseURL。
  - 内置轻量 `CircuitBreaker` 在连续 retryable failure 后打开, 冷却前拒绝新请求。

验收:

- `go test ./...` (`services/kimi-gateway`) 通过。
- `node --test` 全量 **95 通过 / 0 失败**。
- `npm run smoke:ui` 通过。

---

## 13. 2026-05-21 本轮实现 (Audit EventBus + structured trace logs)

P1-B 完成 — memory audit 写入从同步 `fs.appendFileSync` 改为 `AuditEventBus` 事件发布 + JSONL subscriber 异步落盘, 每条 audit line 结构化携带 `trace_id` / `tenant_id` / `user_id`。

已落地:

- **AuditEventBus** (`apps/host/src/runtime/audit-events.js`):
  - `publish/subscribe/flush` 极简事件总线。
  - subscriber 通过 Promise microtask 异步执行, 避免写 audit 文件阻塞请求 hot path。
  - `createJsonlAuditSubscriber(filePath)` 负责结构化 JSONL 落盘。
- **Memory audit 接入** (`apps/host/src/memory/memory-store.js`):
  - `appendMemoryFact` / `writeMemoryNote` 改为发布 audit event。
  - audit line 同时保留旧 `traceId` 字段并新增标准 `trace_id` 字段, 兼容已有读取方。
- **测试覆盖**:
  - `audit-events.test.js` 断言 subscriber 不 inline 执行, `flush()` 后 JSONL 带 `trace_id`。
  - `server-runtime-features.test.js` 断言 memory route 产生的 audit line 带请求注入的 `trace_id`。

验收:

- `node --test` 全量 **96 通过 / 0 失败**。
- `npm run smoke:ui` 通过。

---

## 14. 2026-05-21 本轮实现 (#历史 run picker)

P2-B 完成 — Composer 新增 `#` 历史任务 picker, 从 runs-index 列最近任务, 选中后读取 run record 并把持久化 `events[]` 回放到对话流, 同时把原 prompt 放回输入框供用户复跑。

已落地:

- **历史 picker** (`apps/windows-client/resources/app.js`):
  - `#` 触发 popover, 支持按 run id / promptPreview / recipeId / status / type 本地过滤。
  - 数据源走 `/api/runs/index?limit=20`, 不扫描文件系统。
  - 选中后读取 `/api/runs/:id`, 高亮最近任务卡, 回放 progress / preview / sources / assistant_end 事件。
  - 若历史 run 带 `recipeId`, 自动恢复 selected recipe; 若带 prompt, 自动回填 Composer 便于复跑。
- **契约 smoke** (`scripts/smoke-ui-contract.mjs`):
  - 新增 `historyRunItems`、`/api/runs/index`、`mode: "history"`、`replayRunEvents` 断言。

验收:

- `node --check apps/windows-client/resources/app.js` 通过。
- `node --check scripts/smoke-ui-contract.mjs` 通过。
- `node --test` 全量 **96 通过 / 0 失败**。
- `npm run smoke:ui` 通过。

---

## 15. 2026-05-21 本轮实现 (Tauri desktop scaffold)

P2-A 的离线迁移骨架完成 — 在不增加 npm dependencies 的前提下, 增加 Tauri v2 shell 配置、Rust command 入口、Node host dev 启动脚本、组件迁移清单和 scaffold smoke。完整 P2-A 验收仍缺本机 Rust/Tauri 工具链: 当前 `cargo` / `rustc` / `cargo tauri` 均不可用, 且环境中 `CARGO_NET_OFFLINE=true`, 所以不能在本轮真实启动 Tauri dev 窗口或打包安装器。

已落地:

- **Tauri shell scaffold** (`apps/windows-client/src-tauri`):
  - `tauri.conf.json` 指向 `http://127.0.0.1:3017` devUrl, `frontendDist` 复用现有 `../resources` 静态前端。
  - `bundle.externalBin = ["binaries/kimi-cowork-host"]`, Rust 侧 `start_node_host` 走 `ShellExt::sidecar("binaries/kimi-cowork-host")`, 不再依赖 PATH 上的 `node` 和源码相对路径。
  - Rust 侧注册 `host_status` / `start_node_host` / `open_path` command; `open_path` 先 canonicalize 并限制在 `KCW_TRUSTED_ROOT`/`KCW_REPO_ROOT`/当前目录内, 再走 opener 插件。
  - 初始化 `tauri-plugin-shell`、`tauri-plugin-opener` 和 `tauri-plugin-notification`; capability 只允许 packaged host sidecar execute, 不再给 broad `shell:allow-open`。
  - `tauri.conf.json` 已设置非空 CSP, 限制脚本/连接/图片来源。
- **Node host dev sidecar** (`scripts/start-tauri-host.mjs`):
  - Tauri dev 期间固定启动 Host API 到 `127.0.0.1:3017`, 业务仍由现有 Node host 承担。
- **React 迁移组件契约** (`apps/windows-client/resources/component-manifest.json`):
  - 覆盖 `MessageBubble` / `ProgressLine` / `PreviewCard` / `ApprovalActions` / `ArtifactCard` / `SourcesFooter` / `Composer` / `ClarificationCard` / `TaskStatusBadge`。
- **测试覆盖**:
  - `apps/host/test/tauri-scaffold.test.js` 断言 npm zero-deps、Tauri config、externalBin、CSP、Rust sidecar/opener command/plugin 入口、capability 和组件清单。
  - `scripts/smoke-tauri-scaffold.mjs` 输出当前工具链可运行性; 本机报告 `runnable:false`。

验收:

- `node --check scripts/start-tauri-host.mjs` 通过。
- `node --check scripts/smoke-tauri-scaffold.mjs` 通过。
- `npm run smoke:tauri-scaffold` 通过, 但报告 `cargo` / `rustc` / `cargo tauri` 不可用。
- `node --test` 全量 **99 通过 / 0 失败**。
- `npm run smoke:ui` 通过。

---

## 16. 2026-05-21 本轮修复 (security/idempotency/audit/tauri hardening)

接上轮深度 review, 本轮把已复现的安全边界和一致性问题全部补成回归测试后修复。

已落地:

- **Host API trusted root 收口**:
  - `/api/files/read`、`/api/context/bundle`、`/api/file-ops/preview`、`/api/file-ops/apply` 不再信任 request body 里的任意 `trustedRoot`; 所有请求根都必须落在 host 配置的 `trustedRootDefault` 内。
  - scheduler 默认 executor 也会对 payload.trustedRoot 做相同校验。
- **本地 API 请求边界**:
  - 所有 mutating `/api/*` 请求检查 `Origin`; 仅允许无 Origin、`null`、Tauri scheme、localhost/127.0.0.1/::1。
  - `withJsonBody` 默认强制 `content-type: application/json`, 阻断 `text/plain` simple POST。
- **tenant 隔离补齐**:
  - `/api/runs`、`/api/tasks`、`/api/runs/:id`、`/api/runs/:id/events` 均按 request tenant 过滤; 其他 tenant 读取返回空列表或 404。
- **Idempotency-Key 收口**:
  - `/api/file-ops/apply`、`/api/recipes/:id/run`、`/api/schedules` create/cancel/delete/_tick 强制 `Idempotency-Key`。
  - idempotency cache 增加稳定 body fingerprint; 同 tenant/user/path/key 但 body 不同返回 409, 防止错体复用旧结果。
- **SQLite / audit 修复**:
  - `SqliteMemoryStore` 的 facts/notes 写入同样发布 memory audit JSONL。
  - `AuditEventBus.flush()` 不再吞 subscriber failure, 会用 `AggregateError` 暴露失败。
  - SQLite migration runner 对每个 migration 文件加 `BEGIN IMMEDIATE` 事务, 失败时 rollback 且不记录 schema_migrations。
- **Tauri scaffold hardening**:
  - Tauri config 增加 `bundle.externalBin` host sidecar 契约和非空 CSP。
  - Rust 侧 `start_node_host` 改用 packaged sidecar, 不再 `Command::new("node")`。
  - `open_path` 改为 trusted-root 内 canonicalized path + `tauri-plugin-opener`; capability 移除 broad `shell:allow-open`, 只允许 host sidecar execute。

新增/更新测试:

- `apps/host/test/server-security.test.js` 覆盖 Origin/JSON、trustedRoot escape、tenant run 泄漏、idempotency mismatch。
- `apps/host/test/sqlite-adapters.test.js` 覆盖 SQLite memory audit 与 migration rollback。
- `apps/host/test/audit-events.test.js` 覆盖 subscriber failure 可见性。
- `apps/host/test/tauri-scaffold.test.js` 与 `scripts/smoke-tauri-scaffold.mjs` 覆盖 sidecar/opener/CSP/capability 契约。

验收:

- `node --test --test-isolation=none` 全量 **105 通过 / 0 失败**。
- `npm run smoke:ui` 通过。
- `npm run smoke:host` 通过。
- `npm run smoke:tauri-scaffold` 通过, 仍报告本机 `cargo` / `rustc` / `cargo tauri` 不可用, 因此未做真实 Tauri dev window/installer 验收。
- `go test ./...` (`services/kimi-gateway`) 通过。

---

## 17. 2026-05-21 本轮实现 (God-class split + schedule hardening)

接续深度 review, 本轮继续拆分 `server.js` / `app.js` 上帝文件, 并修复 review agent 发现的 schedule mutation 与 JSON body byte limit 问题。

已落地:

- **后端上帝类拆分**:
  - `apps/host/src/routes/memory-routes.js`: 承接 `/api/memory`、facts、notes。
  - `apps/host/src/routes/run-routes.js`: 承接 `/api/tasks`、runs index、run detail、SSE events。
  - `apps/host/src/routes/schedule-routes.js`: 承接 schedules CRUD 与 `_tick`。
  - `apps/host/src/server.js` 降到约 592 行, 继续保留 `createServer(config)` 入口。
- **前端上帝类拆分**:
  - `apps/windows-client/resources/app-api-client.js`: 承接 `getJson` / `postJson` 和 idempotency header 注入。
  - `apps/windows-client/resources/app-run-events.js`: 承接 SSE event payload 渲染与 `EventSource` 订阅。
  - `index.html` 和 Host 静态白名单同步新增两个 classic script; smoke 会解析所有 script 逐个 GET。
- **schedule hardening**:
  - `/api/schedules/<id>/cancel`、`DELETE /api/schedules/<id>`、`POST /api/schedules/_tick` 均强制 `Idempotency-Key`。
  - cancel/delete 先校验 schedule 属于当前 request tenant; 跨租户返回 404。
  - 手动 `_tick` 只触发当前 tenant 的 due schedules, 不能替其他 tenant 触发任务。
- **request body limit 修复**:
  - `readJsonBody` 改为按 UTF-8 byte length 累计 chunk, 不再用 JS 字符长度低估 CJK/emoji payload。
- **run id 错误收口**:
  - `GET /api/runs/:id` 非法 id 返回 400, 与 SSE route 行为一致。

新增/更新测试:

- `apps/host/test/request-utils.test.js` 覆盖多字节 JSON body 超限。
- `apps/host/test/server-security.test.js` 覆盖 schedule mutation 缺 idempotency key 与跨租户 cancel/delete/tick。
- `apps/host/test/server-runtime-features.test.js` 覆盖 schedule mutation 正常路径 idempotency header、run detail 非法 id。
- `apps/host/test/server.test.js` 和 `scripts/smoke-ui-contract.mjs` 覆盖新增前端静态脚本。

验收:

- `node --check apps/windows-client/resources/app.js` 通过。
- `node --test --test-isolation=none` 全量通过。
- `npm run smoke:ui` 通过。

---

## 18. 2026-05-21 本轮实现 (Route/client split + stream hardening)

接续“全部修复”深度 review, 本轮继续拆 `server.js`、`app.js`、`services/kimi-gateway/internal/kimi/client.go`, 并把并行审查发现的 Go gateway 行为风险全部补成回归测试后修复。

已落地:

- **后端 route 继续拆分**:
  - 新增 `apps/host/src/routes/workspace-file-routes.js`, 承接 files/tree、upload import、files/read、extract、search、context bundle、file-ops preview/apply。
  - 新增 `apps/host/src/routes/recipe-routes.js`, 承接 `/api/recipes` 与 `/api/recipes/:id/run`。
  - `apps/host/src/server.js` 降到约 442 行, `createServer(config)` 入口保持不变。
- **Recipe route 输入收口**:
  - `/api/recipes/:id/run` 对非法 route id 返回 400, 避免 encoded slash 等异常 id 落到 registry lookup。
- **前端 composer controller 拆分**:
  - 新增 `apps/windows-client/resources/app-composer-popover.js`, 承接 `/` 模板、`@` 文件 mention、`#` 历史 run picker 的 state、渲染、键盘处理。
  - `index.html`、Host 静态白名单、`server.test.js`、`smoke-ui-contract.mjs`、`verify-mvp.mjs`、`smoke-windows-client-resources.mjs` 均同步新增脚本契约。
  - `apps/windows-client/resources/app.js` 降到约 1739 行; `node --check` 已验证未截断。
- **测试入口对齐**:
  - `package.json` 的 `test` script 对齐为默认 `node --test`, 与 handoff 要求一致; 受 Windows 沙箱限制时仍可用 `node --test --test-isolation=none` 做本地补充验证。
- **Go gateway 拆分**:
  - `services/kimi-gateway/internal/kimi/types.go`: DTO / stream event constants。
  - `breaker.go`: `CircuitBreaker`。
  - `response_parser.go`: OpenAI-compatible response / SSE payload / message content validation。
  - `stream_handler.go`: `POST /v1/chat/stream`、multipart decode、SSE writer。
  - `client.go` 降到约 321 行, 保留 `NewClient` / `Chat` / `ChatStream` / transport / retry flow。
- **Go gateway hardening**:
  - SSE stream 如果 EOF 前没有收到 `[DONE]`, 不再伪造 done, 返回 `kimi stream ended before [DONE]`。
  - Circuit breaker 不再挡掉同一次调用内的 fallback attempt; 只在调用开始时拒绝已打开 breaker, 调用耗尽 retryable failure 后再记录失败。
  - 上游非 2xx 错误不再把 response body 拼进错误字符串, 避免泄漏上游细节。
  - 结构化 message content parts 必须包含非空 text 或非空 image_url。
  - multipart stream handler 在写 `200 OK` 前限制总请求大小、拒绝非法 `max_tokens`、拒绝空 prompt/image, 并清理 multipart 临时文件。

新增/更新测试:

- `apps/host/test/server-runtime-features.test.js`: recipe route 非法 id 返回 400。
- `apps/host/test/server.test.js`: 新增 composer popover 静态资源。
- `services/kimi-gateway/internal/kimi/client_test.go`: 覆盖 missing `[DONE]`、错误 body 不泄漏、breaker fallback、空 content parts、非法 multipart、超大 multipart。
- `scripts/smoke-ui-contract.mjs` / `scripts/verify-mvp.mjs` / `scripts/smoke-windows-client-resources.mjs`: 覆盖新增前端脚本。

验收:

- 全 repo JS/MJS `node --check` 通过。
- `node --test` 全量 **110 通过 / 0 失败**。
- `npm run smoke:ui` 通过。
- `npm run smoke:host` 通过。
- `npm run smoke:windows-resources` 通过。
- `npm run smoke:rendered-ui` 通过。
- `npm run smoke:tauri-scaffold` 通过, 仍报告本机 `cargo` / `rustc` / `cargo tauri` 不可用。
- `npm run smoke:mvp-runtime` 通过。
- `npm run verify:mvp` 全部 **20/20 passed**。
- 所有 Go module: `go test -count=1 -mod=readonly ./...` + `go vet -mod=readonly ./...` 通过。
- `npm ls --depth=0` 显示 `(empty)`, 仍保持 zero external npm deps。
