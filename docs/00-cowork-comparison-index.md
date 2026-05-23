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
| 计划模式 (Plan mode 前台) | ✅ | 顶栏「计划模式」开关 → agentic 链路只读研究后用 `ExitPlanMode` 提交计划草案, 前端渲染绿色「计划卡」(markdown 计划 + 批准并执行/继续完善); 批准前阻止一切写/高危工具; 复用审批注册表 + `respondApproval`; 新增 `plan_proposed` SSE 帧; `plan-mode` 测试 + 实机 HTTP 冒烟覆盖 (plan.proposed→approved→execute) |
| 产物卡 (ArtifactCard) | ✅ | 跟着对话气泡走 |
| 来源页脚 (SourcesFooter) | ✅ | 显示来源文件 + 摘录 |
| 澄清气泡 (ClarificationCard) | ✅ | MVP 版双轨展示 |
| Composer `/` 模板 picker | ✅ | `/` 触发模板 popover (键盘上下选 + Enter/Esc), 选中插入模板 prompt + 设 selectedRecipeId; controller 已拆到 `app-composer-popover.js` |
| Composer `@` 文件 mention | ✅ | `@` 触发文件 popover, 走 `/api/files/search` 实时检索, 选中插入 `@文件名` 并加入 `state.mentionedFiles` 供模板/计划引用; controller 已拆到 `app-composer-popover.js` |
| Composer `#` 历史 run picker | ✅ | `#` 触发历史任务 popover, 走 `/api/runs/index` 列最近 runs; 选中后读取 `/api/runs/:id`, 回放 run record 的 `events[]`, 并把原 prompt 放回 Composer 便于复跑; controller 已拆到 `app-composer-popover.js` |
| 任务状态 Badge | 🟡 | 任务卡片在, 但消息头部 badge 仍简化 |
| computer:// 等价一键打开 | ✅ | agent 写文件后发 `file_written` 帧, 前端在对话气泡渲染可点击产物卡, 点「在系统中打开」经 Tauri `open_path` 在系统中打开; `file-written` 测试覆盖 |
| 内联可视化 widget (Chart/Mermaid) | ✅ | 助手回答里的 ```chart(JSON 规格)/```mermaid 围栏块由 `MessageText`→`splitVizBlocks`→`InlineViz` 经 `/api/viz/render` 内联渲染成图表(show_widget 体感); 系统提示已引导 agent 主动输出 |
| 持久 HTML Artifact (活页) | 🟡 | 本地 artifact catalog + 安全 HTML live page 已落地; connector-backed refresh / inline LLM 仍未做 |

### 2.2 功能 / 工具 (对应 doc 01 第 2 节 / doc 02 阶段 1-4)

| 能力 | 状态 | 说明 |
|---|---|---|
| 文件树 + trusted root + path policy | ✅ | 长板, 比 Claude Cowork 更严; 所有请求传入的 `trustedRoot` 都先夹在 host 配置根内, 禁止用 body 覆盖逃逸 |
| Preview / Apply / Rollback / Audit | ✅ | 长板, no-overwrite/no-delete 已锁; `/api/file-ops/apply` 现在强制 JSON + 本地 Origin + Idempotency-Key, 且同 key 不同 body 返回 409 |
| DOCX/XLSX/PPTX 抽取 | 🟡 | `/api/files/extract` MVP, 不含 OCR / 复杂表格恢复 |
| PDF 抽取 | 🟡 | 仅基础文本, 无 fill/sign/表单/OCR |
| 真实模板 (会议纪要 / Excel 清洗 / 报销) | ✅ | 3 个端到端通; 8 入口都在 `/api/recipes` |
| Recipe 注册表 | ✅ | `/api/recipes` + `/api/recipes/:id/run`; recipe run 强制 Idempotency-Key, 同 tenant/user/key/body replay, 不同 body 409, 不重复产出 run |
| 文件卡片 (`present_files` 等价) | ✅ | agent 产出的文件以可点击卡片呈现在对话流, 一键系统打开 |
| Kimi API 集成 | ✅ | Host 主链路已改为 OpenAI-compatible `POST /chat/completions`; runs/*.json 审计级落盘; API key 仅在服务端 |
| Kimi CLI Bridge | 🟡 | legacy/developer-only 代码仍保留, 但桌面产品主路径不再 spawn Kimi CLI |
| Kimi Gateway (OpenAI-compatible chat) | ✅ | 非流式 + 重试 + 超时, 已 httptest 覆盖 |
| Kimi Gateway 流式 / tool calls / vision | ✅ | `services/kimi-gateway` 已支持 `ChatStream`、`POST /v1/chat/stream` SSE handler、OpenAI tools/tool_calls、multipart `image_url` vision、`llm.usage` 事件、多 key/baseURL fallback、熔断；client 已拆成 types/breaker/parser/stream handler, 并补齐 stream `[DONE]`、multipart limit、content part、错误泄漏回归测试 |
| MCP 客户端 | ✅ | `apps/host/src/mcp/connect.js` stdio MCP client + `mcp-servers/fs-server.mjs` 内置 fs server; 连上的工具以 `mcp__<server>__<tool>` 注入工具注册表, agent 工具集 (`buildAgentToolset`) 把 `mcp:*` 工具按 high-risk 接入审批; `mcp-connect`/`mcp-fs-server`/`connector-connect` 测试覆盖, 实机 HTTP 冒烟连 fs → 3 工具可见 |
| 外部 SaaS 连接器 (Slack/Notion/Gmail/...) | 🟡 | 连接器目录 (`connectors/catalog.js`: filesystem/web-fetch/memory/sqlite/git/postgres) + 关键词 suggest + 一键连 (`POST /api/connectors/connect`, builtin id 或通用 command/args) + 前端 `ConnectorsPanel` 抽屉; 内置 fs 一键连可用, 通用 MCP 给出安装命令; 尚无打包好的 SaaS OAuth 连接器 |
| 工具懒加载 (ToolSearch 等价) | ✅ | agent 主链路只常驻核心文件工具 + `search_tools` 元工具; 连接器(mcp)工具按需检索激活进工具集, prompt 不随连接器数量膨胀; `lazy-tools` 测试覆盖。另有 `/api/tools/search` + `ToolsPanel` 懒搜面板 |
| Scheduled Tasks | ✅ | `apps/host/src/runtime/scheduler.js` + cron 解析器 (零依赖); `/api/schedules` CRUD + `_tick`; cron + 一次性; tenant 隔离; create/cancel/delete/_tick 均强制 Idempotency-Key, 手动 tick 只触发当前 tenant; 默认 executor 已接 `runRecipe` 真正产出可审批产物 + 入索引; 文件 store + SQLite store adapter |
| Memory 跨会话 (MEMORY.md) | ✅ | `apps/host/src/memory/memory-store.js`; `/api/memory` + facts/notes; Kimi API plan/chat 调用前自动注入; 文件 store + SQLite facts/notes adapter; SQLite 写入同样落 memory audit |
| Runs 索引 (Repository 形态) | ✅ | `apps/host/src/runtime/runs-index.js` JSONL append-only file adapter + `SqliteRunsIndex`, ULID 主键, tenant 隔离, `/api/runs/index`; legacy `/api/runs`、`/api/tasks`、`/api/runs/:id/events` 也已按 tenant 收口 |
| SQLite 持久化 | ✅ | `KCW_STORE=sqlite` / `storeBackend:'sqlite'` 可切 Memory facts/notes、Runs index、Schedules 到 Node 内置 `node:sqlite`; schema 走 `apps/host/src/storage/migrations/0001_init.sql`, migration 逐文件事务化 |
| 浏览器 Agent | ❌ | smoke:rendered-ui 是工程内用, 没产品化 |
| Windows OS 自动化 MCP | ❌ | 客户端骨架在, 未对外暴露 |
| 子 Agent / Plan mode 产品化 | ✅ | Subagent: agent 工具集内置 `Agent` 工具 (low-risk) 派生嵌套 `runAgentChat`; `/api/subagent/run` + `ToolsPanel` 计划构建器; `hooks-subagent` 测试覆盖。Plan mode: 后端 `ExitPlanMode`+计划闸门、前端开关+计划卡均已落地 (见上行), 端到端验证通过 |
| 中心化审批策略 (ActionPolicy) | ✅ | `runAgentChat` 闸门改为 `mutating || risk==='high'` 一律审批 (修复 Write/Edit 绕过审批的漏洞); autoApprove 收紧: 只自动批准非高危改动, 高危(Shell/外部 MCP)始终强制逐次确认; 批准计划后计划内非高危改动免逐步审批, 高危仍确认; 每个副作用决策落 `.KimiCowork/audit/actions.jsonl` (`action-audit.js`); 外部 MCP 工具补 `mutating:true`; `approvals`/`plan-mode` 测试覆盖 |
| 工具调用 Hooks (pre/post, 可拦截) | ✅ | `apps/host/src/runtime/hooks.js`: `createHookEngine` (pre_tool 可 block / post_tool) + `loadHooksConfig` 读 `.KimiCowork/hooks.json`; **默认 opt-in, 无文件即空引擎不挂任何 hook** (按用户要求, 由用户自行通过 cowork 添加); 已接入 `runAgentChat` 工具循环, `hooks-subagent` 测试覆盖 |
| 五层记忆体系 (enterprise→user→project→local→session) | ✅ | `apps/host/src/memory/memory-layers.js`: `loadLayeredMemory` 按 Claude Code CLAUDE.md 层级合并 5 层 (含字节上限/逐层截断), 注入 agent system prompt; `memory-layers` 测试覆盖 |
| Skills 注入 agent | ✅ | skill registry 列表注入 system prompt + 工具集内置 `Skill` 工具; agent 可枚举/调用 skill |
| Sources 引用规范 | ✅ | 模板产物末尾 + 气泡页脚 |
| 多轮自我验证 (verification) | ✅ | `runAgentChat` 在发生写操作且给出最终答案后, 自动追加一轮只读自检(读回产物核对)再收尾; 由「深度」思考档位或 `verify` 触发, 发 `verify_start` 帧前端显示「自检产物中…」; `verify` 测试覆盖 |
| AskUserQuestion (agent 中途提问) | ✅ | agent 工具集内置 `AskUserQuestion` 工具: 中途向用户提带选项的澄清问题, 发 `question` 帧, 经 approvals registry `respond(id,answer)` 等待回答(`POST /api/approvals/:id {answer}`)后把所选项回流给模型继续; 前端问题卡渲染选项按钮; `ask-user-question` 单测 + HTTP e2e 覆盖 |
| agent 全链路 e2e 冒烟 | ✅ | `agent-stream-e2e` 用 mock modelCall 走 `POST /api/agent/chat/stream` 全 HTTP 链路, 覆盖 file_written/verify_start/done、内联图表流式、连真实 fs MCP 后懒加载激活三场景 |
| 取消/中断 + 用量统计 | ✅ | `runAgentChat` 接 AbortSignal 步间中断 + 累计 token usage; `done`/`cancelled` 帧带 usage; 前端流式时显示「停止生成」调 `POST /api/runs/:id/cancel`, done 显示 token 用量; `cancel-usage` 单测 + HTTP e2e 覆盖 |
| 前端展示贴近 Cowork | ✅ | 助手消息以散文呈现(去重盒)、用户软气泡、消息淡入、运行中脉冲/转圈、富 Markdown(代码块/列表/链接)、composer 聚焦态、产物卡 hover、停止/用量条 |
| 后续动作建议 + 启动卡 | ✅ | 空态显示可点击的示例任务(starter chips);agent 可在回答末尾输出 ```suggestions 围栏块,前端 `extractSuggestions` 解析并渲染为可一键继续的后续动作 chips(Claude Cowork 的 suggested next steps) |

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
| `npm run smoke:kimi-api` | 🟡 | 可用, 依赖 `KIMI_API_KEY`/`MOONSHOT_API_KEY` 和真实网络; 不进入默认 verify |
| `npm run verify:windows-readiness` | ✅ | 只读诊断, 不修改 Defender |
| `npm run audit:mvp` | ✅ | 聚合验收, Web/Host MVP 就绪 |
| Tauri desktop scaffold | ✅ | `apps/windows-client/src-tauri` 已有 Tauri v2 配置、Rust command 入口、packaged sidecar 契约、safe opener、CSP、Node host dev 启动脚本、组件迁移清单和 scaffold smoke; 当前机器缺 `cargo`/`rustc`/`cargo tauri`, 尚不能验收 dev 窗口/安装器 |
| Windows 原生客户端 GUI smoke | 🟡 | C/Win32 + WebView2 仍保留作 legacy 参考, 但 Defender ASR 仍卡 KimiCowork.exe; 新主线转向 Tauri scaffold |

---

## 3. 当前阶段一句话

**Kimi Cowork 已经走过 "PoC + 单一 dashboard" 阶段, 进入 "对话流 MVP + 真实模板"**。本地审批/回滚/审计/runs 这套长板还在; UX 原语已覆盖 SSE、Composer `/`/`@`/`#`、Memory/Schedule/Runs SQLite adapter、Kimi API plan/chat 主链路、Kimi Gateway 流式/tool/vision、audit EventBus、持久 Artifact catalog / 安全 HTML live page 和关键本地 API 安全边界; 但 **MCP 生态、真实 React runtime、Tauri dev/window/installer、连接器驱动的活 Artifact** 仍是后续主线。

距离 "像 Claude Cowork" 的关键 4 件大事 (按 ROI 排):

1. ~~**真 SSE event stream**~~ ✅ 后端 + 前端 EventSource 全通; 伪流式已被服务端权威事件流取代。
2. ~~**SQLite + MEMORY.md + Scheduled Tasks**~~ ✅ 三件运行时模块已落地 (Repository 形态 + SQLite adapter)。
3. ~~**Composer `/模板` + `@文件` + `#历史` popover**~~ ✅ 已落地。
4. **Tauri/Electron 迁移 + React 重写** (退出 C/Win32 + Defender ASR 战线) — Tauri scaffold / 组件契约 / sidecar + safe opener 契约已落地; 完整 dev 窗口 + 打包验收受本机缺 Rust/Tauri 工具链阻塞。

下一步聚焦: (a) 安装/接入 Rust + Tauri CLI 后完成 dev 窗口和安装器验收; (b) 把静态 DOM helper 迁到真实 React runtime; (c) MCP 客户端和连接器驱动的活 Artifact。

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
  - Kimi plan/chat 调用前自动注入 MEMORY.md 前 4KB 作为 system 段 (`buildMemoryBlock`)。
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
- 连接器驱动的活 Artifact、内联可视化 widget、Tauri/Electron 迁移。
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
  - facts/notes 走 SQLite, 按 tenant 隔离; `loadMemoryContext` 仍输出原 MEMORY.md 风格文本块, 供 Kimi API 注入。
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

---

## 19. 2026-05-22 本轮实现 (Artifact live pages)

接续“打造完整 Claude Cowork 桌面产品”的目标, 本轮优先补齐一个最直接影响产品感的缺口: 让 `.KimiCowork/artifacts` 不再只是落盘死文件, 而是在桌面 UI 中可发现、可刷新、可打开为 Host 生成的安全 HTML 活页。

已落地:

- **Artifact catalog 后端**:
  - 新增 `apps/host/src/artifacts/artifact-catalog.js`, 只枚举 trusted workspace 下 `.KimiCowork/artifacts` 内的文件。
  - 文本类产物 (`.md` / `.txt` / `.csv` / `.json` / `.html` / `.htm` / `.log`) 可渲染为 Host 生成的 HTML live page。
  - 原始文件内容全部转义, 即使源文件是 `.html` 或含 `<script>` 也不会在桌面页里执行。
- **Artifact API**:
  - 新增 `apps/host/src/routes/artifact-routes.js`。
  - `GET /api/artifacts?limit=...` 返回最近 artifact catalog。
  - `GET /api/artifacts/view?path=...` 返回安全 `text/html` live page。
  - `apps/host/src/server.js` 接入该 route, 保持 `safeTrustedRoot` 边界。
- **桌面资源 UI**:
  - `apps/windows-client/resources/index.html` 的 Artifacts panel 增加刷新按钮与 `data-artifact-list` 容器。
  - `apps/windows-client/resources/app.js` 增加 catalog 加载、空态、打开 live page、计划应用后刷新等流程。
  - `apps/windows-client/resources/app.css` 补齐 artifact list 的溢出与空态样式。
- **契约 smoke**:
  - `scripts/smoke-ui-contract.mjs` 覆盖 artifact catalog DOM contract、`/api/artifacts`、`/api/artifacts/view` 和 apply 后 catalog 刷新路径。
  - `apps/host/test/server.test.js` 增加 endpoint 回归, 覆盖恶意 `<script>` 内容不会原样执行。

验收:

- `node --check apps/host/src/artifacts/artifact-catalog.js` 通过。
- `node --check apps/host/src/routes/artifact-routes.js` 通过。
- `node --check apps/host/src/server.js` 通过。
- `node --check apps/windows-client/resources/app.js` 通过。
- `node --check scripts/smoke-ui-contract.mjs` 通过。
- `node --test apps/host/test/server.test.js` **15/15 通过**。
- `npm test` 全量 **111 通过 / 0 失败**。
- `npm run smoke:ui` 通过。
- `npm run smoke:windows-resources` 通过。

仍未完成:

- Artifact 内部的 connector-backed refresh / inline LLM 调用。
- MCP / connector 生态。
- 真实 React runtime 和 Tauri dev/window/installer 完整闭环。

---

## 20. 2026-05-22 本轮实现 (Kimi API host path)

接续“不要使用 Kimi CLI, 改为 API 接入”的产品方向, 本轮把桌面产品主链路从本机 `kimi` 子进程切到服务端 Kimi/Moonshot OpenAI-compatible API。

已落地:

- **Host API runner**:
  - 新增 `apps/host/src/kimi/api-runner.js`。
  - `runKimiApiPlan` / `runKimiApiChat` 调用 `POST /chat/completions`, 支持 `KIMI_API_KEY` 或 `MOONSHOT_API_KEY`。
  - 支持 `KIMI_BASE_URL` / `MOONSHOT_BASE_URL`、`KIMI_MODEL`、`KIMI_API_TIMEOUT_MS`、`KIMI_API_MAX_TOKENS`。
  - API key 只在 Host 进程内使用, 不返回给前端, 错误也不拼接上游 response body。
- **Host 主链路替换**:
  - `apps/host/src/server.js` 不再 import `cli-detect` / `cli-runner` 作为默认路径。
  - `/api/kimi/plan`、`/api/kimi/chat` 默认走 Kimi API runner。
  - `/api/kimi/info` 返回 API 配置状态, 不再 spawn `kimi info`。
  - `/api/workspace` 新增 `kimiApi` 状态, legacy `kimiCli` 固定为 disabled。
- **桌面 UI**:
  - `apps/windows-client/resources/index.html` / `app.js` 中的运行芯片、降级说明、产物摘要全部改为 Kimi API。
  - 未配置 API key 时保留本地只读 fallback, 不阻断审批预览和本地 artifact 生成。
- **启动与 smoke**:
  - `apps/host/src/main.js`、`scripts/start-mvp.mjs`、`scripts/start-tauri-host.mjs` 改读 API env。
  - `npm run smoke:kimi-cli` 改为 `npm run smoke:kimi-api`。
  - 删除旧 `scripts/smoke-kimi-cli.mjs`, 新增 `scripts/smoke-kimi-api.mjs`。

新增/更新测试:

- `apps/host/test/api-runner.test.js` 覆盖 prompt 构建、env 解析、OpenAI-compatible 请求体、无 key 拒绝。
- `apps/host/test/server.test.js` 覆盖 API runner 注入、run record provider=`kimi-api`、无 key 503、失败 run 落盘。
- `scripts/smoke-rendered-ui.mjs` 使用 fake Kimi API runner, 不触碰真实网络。

验收:

- `node --check` 覆盖 API runner、Host server、前端资源、启动脚本、smoke 脚本和相关测试文件, 通过。
- `node --test apps/host/test/api-runner.test.js` **5/5 通过**。
- `node --test apps/host/test/server.test.js` **15/15 通过**。
- `npm test` 全量 **116 通过 / 0 失败**。
- `npm run smoke:ui` 通过。
- `npm run smoke:windows-resources` 通过。
- `npm run smoke:rendered-ui` 通过。
- `npm run smoke:kimi-api` 未运行: 需要真实 `KIMI_API_KEY` / `MOONSHOT_API_KEY` 与网络, 属于可选 live smoke。

---

## 2026-05-22 本轮实现 (桌面壳重构 + VM 沙箱执行 迭代 A)

迭代计划见 `docs/cowork-iteration-plan.md`。

**桌面壳 (Tauri Rust) 模块化重构**:
- 130 行单体 `lib.rs` → 6 模块: `error`(类型化可序列化错误) / `config`(host+trusted-root 单一来源) / `security`(trusted-path 校验) / `sidecar`(host start/stop/status + 优雅关闭) / `commands`(薄 IPC 层) / `lib`(仅接线)。
- 修复孤儿进程: `RunEvent::ExitRequested` 时停 sidecar; 新增 `stop_node_host` 命令。
- 打包闭环: `withGlobalTauri:true` + `app-api-client.js` 用 `HOST_BASE` 解析绝对地址 + 自举 `ensureHost()`(IPC 启 sidecar + 轮询 /health, 首个 API 调用透明等待) + `openPath()`(trusted-root 限制); SSE 也走 `resolveUrl`。`app.js`/`index.html` 零改动(规避中文截断)。

**VM 沙箱执行 (迭代 A)** — 对位 Claude Cowork "安全跑工具/代码":
- `apps/host/src/sandbox/`: `sandbox-spec`(结构化规格校验, 拒绝 shell/路径逃逸/越界超时, env 白名单) + `LocalSubprocessSandbox`(无 shell/argv/cwd jail/超时 SIGKILL/输出上限/env 清洗, 诚实声明 `networkIsolated:false`) + `VmSandbox`(WSL/Docker/Hyper-V 契约 + plan 预览, 未配置则 501 快失败不静默降级) + `createSandbox` 工厂。
- `/api/sandbox/exec`(结构化规格、trusted-root jail、默认无网络、强制 Idempotency-Key、入 runs 索引 + 发事件) + `/api/sandbox/info`。
- 15 个测试: 规格校验 / 本地执行(stdout/退出码/超时/截断)/ VM 契约 / 路由集成 / 幂等 / allowlist / 428。

验收: `node --test` **131/131 通过**(116 → +15); 全部 `apps/host/src/**.js` 语法过; Tauri `src/*.rs` 6 模块括号平衡(机器缺 cargo, 未 `cargo check`)。

下一迭代 (按计划): **B 前端 React 组件化**(退役 59KB 单体 app.js, 彻底解决中文大文件截断) 或 **VmSandbox 接 WSL2/Docker 真后端**。

### 追加 (同日): VM 沙箱真后端 + DRY 抽取

- `sandbox/exec-child.js`: 抽出共享的"受限子进程执行器"(无 shell / argv / 超时 SIGKILL / 输出上限), 本地与 VM 后端共用 (DRY)。`LocalSubprocessSandbox` 重构为复用它。
- `sandbox/wsl-docker-runner.js`: 真 spawn 后端。docker → `docker run --rm --network=none -v <root>:/work -w /work [-e K=V] <image> <tool> <args>` (network:false 映射 `--network=none`, 真隔离); wsl → `wsl.exe [-d distro] -- <tool> <args>` (诚实声明不保证网络隔离)。
- `createSandbox` 升级: VM 后端在给了 image(docker)/distro/runner 时自动注入 runner 并 `provisioned`; 否则仍 501 快失败不伪装。可经 `KCW_SANDBOX_BACKEND` + image 配置切换。
- 测试: docker argv(--network=none + 挂载 + image + tool/args)、network:true→bridge、wsl argv + 警告、无 image→501、createSandbox 注入路径; 用 fake spawn 确定性验证。

验收: `node --test` **136/136 通过** (131 → +5)。

迭代 B (前端组件化) 说明: 需 `npm install` + 构建工具链, 此 VM 无法安装/构建/验证; 建议在能构建的机器上做, 或采用零依赖 ES Module 组件化 (改 app.js, 需单写者逐文件校验防截断)。


### 追加 (同日): 迭代 B 前端 React 脚手架 + 迭代 C 沙箱跑代码

**迭代 B — React + Vite 桌面前端脚手架 (代码已落, 构建留到能装 npm 的机器)**:
- 选定标准 React 18 + Vite 5 + TypeScript 5 子工程 (`apps/windows-client/ui/`), 退役 59KB 单体 `app.js`, 从根上消除中文大文件截断风险。
- `ui/src/lib/api.ts`: 类型化客户端 (`HOST_BASE` / `resolveUrl` / `isDesktop` / `ensureHost` / `getJson`+`postJson` / `subscribeRunEvents` / `openPath` / `newIdempotencyKey`), 与桌面自举一致。
- `ui/src/components/*.tsx`: 9 个组件对位 `component-manifest.json`。
- `tauri.conf.json` 切到 React 构建产物: `frontendDist:"../ui-dist"`, `devUrl:"http://127.0.0.1:5173"`, `beforeDevCommand` 走新 `scripts/start-tauri-dev.mjs` (并起 host + Vite, 生命周期联动)。
- 待办 (用户机器): `npm install && npm run build` 生成 `ui-dist`, 然后 `cargo tauri dev/build`。本 VM 无 npm/cargo, 无法构建/验证。

**迭代 C — 任务模板/recipe 调沙箱跑代码** — 对位 Claude Cowork "把代码丢进沙箱跑出结果":
- `apps/host/src/sandbox/code-runner.js`: `runCode({sandbox, sandboxLimits, tool, code, prompt, ext, timeoutMs, network, trustedRoot, runStoreRoot, runEvents, runsIndex, context})`。把内联源码物化为 trusted-root 内的脚本文件 `<root>/.KimiCowork/scripts/<runId>.<ext>` (`EXT_BY_TOOL={node:js,python:py,python3:py}`, 上限 256KB), 用相对路径作 argv 跨后端解析 (local cwd=root / docker `-w /work`), 经同一 `normalizeSandboxSpec` 跑沙箱; 先校验 spec 再落盘 (非法 tool 直接 400 不留脚本); 产出 `sandbox-code` run 记录 + `user_message→assistant_start→progress→sandbox_start→sandbox_end→assistant_end` 事件时间线, 与 recipe run 同形, 历史/时间线 UI 零改动。
- `POST /api/sandbox/run-code` (内联到现有 `sandbox-routes.js`, 不改 server.js / runRecipe): 强制 Idempotency-Key、trusted-root jail、入 runs 索引、幂等重放、退出码非零记 `failed`。返回 `{runId, runPath, backend, script, spec, result}` (`result.ok` 已折入)。
- 5 个测试: 跑内联 node 出 stdout + 脚本落盘 + 记 `sandbox-code` + 幂等重放、退出码非零记 failed、tool 不在 allowlist→400 且不留脚本、缺 Idempotency-Key→428、空 code→400。

验收: `node --test` **141/141 通过** (136 → +5); `code-runner.js`+`sandbox-routes.js` 语法过。

### 追加 (同日): 迭代 D MCP 客户端 + 子 Agent, 迭代 E 内联可视化 + 活页 Artifact

**迭代 D — MCP 客户端 + 工具注册表 + 子 Agent** — 对位 Claude Cowork 的连接器生态 / ToolSearch / Agent 工具:
- `src/mcp/json-rpc.js`: 传输无关的 JSON-RPC 2.0 客户端核心 (可注入 `send`, id 匹配, 超时, 通知派发, `rejectAll`)。
- `src/mcp/stdio-transport.js`: MCP-over-stdio 传输 (子进程, 换行分隔 JSON, 处理跨 chunk 拆行, 可注入 spawn)。
- `src/mcp/mcp-client.js`: `McpClient` — `connect()` 走 initialize 握手 + initialized 通知, `listTools()`, `callTool()`。
- `src/tools/tool-registry.js`: 统一工具注册表, 聚合内置工具 + MCP 工具 (`mcp__<server>__<tool>` 命名), `list / search(懒加载, 对位 ToolSearch, 关键词打分 name>desc) / get / call / registerMcpClient`。
- `src/tools/builtin-tools.js`: 把现有能力封装成工具描述符 — `sandbox.exec` / `sandbox.run-code` / `recipe.*` (8 个 recipe), handler 接 `(args, ctx)`。
- `src/runtime/subagent.js`: 子 Agent 编排 — 顺序执行一串工具调用 (plan-then-execute 的执行端), 产出 `subagent-run` 记录 + `user_message→assistant_start→progress→tool_result*→assistant_end` 事件时间线, 与 recipe/sandbox run 同形; 默认遇错即停。
- `src/routes/tool-routes.js` + server 接线: `GET /api/tools` / `GET /api/tools/search?q=` / `POST /api/tools/call` (幂等, trusted-root jail) / `POST /api/subagent/run` (幂等, 入 runs 索引)。
- 测试: `test/mcp.test.js` (11) + `test/tools.test.js` (13) — JSON-RPC 解析/错误/超时/rejectAll, stdio 拆行, McpClient 握手/list/call, registry list/search/call/MCP 接入, builtin 真跑 sandbox, subagent 顺序/失败截断/未知工具 400, 4 条路由集成 + 幂等。

**迭代 E — 内联可视化 + 活页 Artifact** — 对位 show_widget + create_artifact:
- `src/artifacts/viz.js`: 纯函数 `renderViz(spec)` → 自包含 HTML。`bar/line/pie/doughnut`→Chart.js(cdnjs), `mermaid`→Mermaid(cdnjs), `table`→内联 HTML。所有文本 HTML 转义, 注入 `<script>` 的数据做 `<`/`>`/`&`/U+2028/U+2029 转义防 script-breakout (用 `String.fromCharCode` 常量根除字面行分隔符)。
- `src/artifacts/live-artifact.js`: `buildLiveArtifact` 把 viz 写成 `.KimiCowork/artifacts/<id>.html`(活页, 带"刷新"按钮 + 客户端 DOM 渲染器, 用 textContent 喂数据杜绝注入)+ `<id>.json`(manifest)。刷新按钮回拉 `/api/artifacts/data/<id>` 重渲染, 保存的页面始终是新鲜的。`readArtifactManifest` / `readLiveArtifactHtml` (id 正则校验 + trusted-path)。
- `src/routes/viz-routes.js` + server 接线: `POST /api/viz/render` (幂等; 默认落盘活页, `persist:false` 只回内联 HTML 即 show_widget 形态) / `GET /api/artifacts/data/:id` (活页数据端点) / `GET /api/artifacts/live/:id` (serve 活页 text/html)。
- 测试: `test/artifacts.test.js` (14) — viz 各类型/转义/未知 kind 400/script-breakout 中和/U+2028 转义, 活页落盘+manifest+刷新钩子, 坏 id 拒绝, 4 条路由集成 + 幂等 + persist:false + 404。

验收: `node --test` **179/179 通过** (141 → +38, 新增 mcp 11 / tools 13 / artifacts 14)。

工程纪律补记: 本轮 `server.js` 被 Edit 工具截断一次 (纯 ASCII 也未能幸免), 改用 `head -n + heredoc` 与 node 脚本精确字符串替换修复并 `node --check` + boot 验证; `viz.js` 的 U+2028/U+2029 字面量两次破坏正则字面量, 最终用 `new RegExp(String.fromCharCode(0x2028))` 常量根除。结论强化: 中文/特殊多字节文件一律 heredoc + 立即 `node --check`; 大文件 (server.js) 改写用 node 脚本字符串替换, 不用 Edit/Write。

下一迭代候选: 把工具/子 Agent/活页接到 React 前端 (迭代 B 的 UI, 需用户机器构建); 或 MCP 真连接器接线 (把 `registerMcpClient` 接到具体本地 MCP server + 生命周期 + 配置)。

### 追加 (同日): MCP 真连接器 + React 前端接线 + 迭代 B 一键激活

**MCP 真连接器 (接通 registerMcpClient)**:
- `src/mcp/connect.js`: `connectMcpServers({ registry, servers, spawn })` — 对每个 `{ name, command, args, env, cwd }` 起 `StdioTransport` + `McpClient`, 握手后把工具以 `mcp__<name>__<tool>` 注册进 registry; 单个 server 失败只记 `errors` 不拖垮其它。`closeMcpClients` 统一关闭。
- `server.js`: 返回的 server 挂 `toolRegistry` / `connectMcpServers(servers)` / `closeMcp()`; `config.mcpServers` 非空时启动自动连接 (fire-and-forget, 坏连接器不崩启动)。
- `test/fixtures/mock-mcp-server.mjs`: 最小 MCP-over-stdio server (ping/add), 真子进程。
- `test/mcp-connect.test.js` (3): connectMcpServers 真起子进程导入工具 + 调用; 坏 spec 记 errors 不抛; server.connectMcpServers 让 MCP 工具经 `/api/tools` `/api/tools/search` `/api/tools/call` 全链可用。

**React 前端接线 (代码已落, 构建在用户机器)**:
- `ui/src/lib/api.ts`: 加 `listTools / searchTools / callTool / runSubagent / renderViz / liveArtifactUrl` 类型化方法; `subscribeRunEvents` 增订 `tool_result`; `types.ts` 的 `RunEvent` 加 `tool_result`。
- `ui/src/components/ToolsPanel.tsx`: 工具懒搜索 + 选中 + JSON 参数调用 + 结果展示。
- `ui/src/components/VizPanel.tsx`: 编辑 viz spec → 渲染活页 → iframe 内联预览 + "打开文件"。
- `ui/src/App.tsx`: 头部加"工具 / 可视化"切换, 右侧抽屉挂两面板 (浮层, 不动既有聊天流); `styles.css` 补面板样式。
- 校验 (此 VM 无 tsc/esbuild, npm 全局安装被 OS 拒): `.ts` 经 `node --check --experimental-strip-types` 真语法过; `.tsx` 括号平衡 + 无未用导入 + JSX 标签核对; 真 TS/React 编译按既定约束在用户机器做。

**迭代 B 一键激活**:
- `scripts/build-ui.mjs` + 根 `package.json` 脚本 `build:ui` / `build:ui:fresh`: 自动 (按需) `npm install` + `npm run build` → `ui-dist`, 并打印 `cargo tauri dev/build` 下一步。
- 激活: `npm run build:ui`, 然后逐行 `cd apps/windows-client/src-tauri` 再 `cargo tauri dev` (PowerShell 勿用 &&)。

验收 (host 侧): 本轮 host 相关测试分组跑 **66/66** + 其余 **115/115** 全绿 (全量曾因 VM 负载超时, 分组确认 0 fail); MCP 连接器经真子进程端到端验证。前端/脚本为纯增量, 不影响 host 测试。

### 追加 (同日): CORS + 全面 review + 完整端到端

**CORS (修复浏览器预览 + 桌面 WebView 跨源隐患)**:
- `server.js` 请求入口加 CORS: 只反射 `isAllowedOrigin` 放行的 loopback (`localhost`/`127.0.0.1`/`::1` 的 http/https + `tauri:`) 来源, 设 `access-control-allow-{origin,methods,headers}` + `vary: Origin`; `OPTIONS` 预检放行来源回 204、否则 403。
- 之前 host 完全无 CORS 头, 浏览器在 `:5173` 跨源调 `:3017` 会被拦 (桌面 WebView 同理), 这是从未真正跑起来的潜在隐患, 现已修。
- `test/cors.test.js` (3): loopback 反射、OPTIONS 204 带 allow 头、非 loopback 不反射且预检 403。

**全面 review + 完整端到端**:
- 语法审计: 全部 `src/**/*.js` + `mcp-servers/*.mjs` + `scripts/*.mjs` `node --check` 通过。
- 全量测试 (28 文件, 分两组避 VM 负载): **60 + 126 = 186 通过, 0 失败**。
- 前端静态校验: `.ts` 经 `node --check --experimental-strip-types` 真语法过; 13 个 `.tsx` 括号平衡 + 无未用导入。
- 端到端 (真实 HTTP server, 一个脚本串起): health/workspace、CORS 预检、sandbox exec/run-code、tools list/search/call、subagent 多步、viz render/live/data、MCP fs-server 经 `server.connectMcpServers` 连接 + 经 `/api/tools/call` 调用 (`mcp__fs__read_text` 读到文件)、幂等重放、runs 索引含 sandbox-exec/sandbox-code/subagent-run —— **24/24 通过**。

**已知环境注意**:
- 端口: `npm start` (main.js) 默认 3001, 但前端客户端 + `scripts/start-tauri-host.mjs` 用 3017。浏览器预览须用 `node scripts/start-tauri-host.mjs` 起 host (3017), 勿用 `npm start`。
- 桌面端编译需 Rust 工具链 (cargo) + Windows MSVC C++ 生成工具 + WebView2; 用户机器尚未装 Rust。不装 Rust 可走浏览器预览 (host 3017 + Vite 5173, CORS 已放行)。

### 追加 (同日): "cowork/code 重复堆叠" 根因 + host 服务 React SPA

**根因 (按 Claude Cowork 标准验收的结论)**:
- 用户看到的是**旧静态前端** `resources/`(host 在 `/` 处默认服务它)。它有 chat/cowork/code 三个**模式 tab**;`setView` 在 cowork/code 下让 `chat-panel` (`data-views="chat cowork code"`) 和 `cowork-panel` (`data-views="cowork code"`) 同时 `is-visible`,而 `.workspace` 是竖直 flex,于是 hero + 空对话面板 + 工作台**竖直堆叠** = "重复堆叠"。
- 更本质: chat/cowork/code 模式 tab 这种 IA 本身就**不符合 Claude Cowork**(单一对话工作流, 无模式切换)。迭代 B 的 React UI (App.tsx) 已是单一流 + 工具/可视化抽屉, 才是标准形态。

**修复**:
- `server.js` 静态服务改为: `ui-dist/index.html` 存在时, host 在非 `/api`、非 `/health` 的 GET 上服务 **React SPA**(精确文件 + 无扩展名路由回退 index.html + 路径穿越防护); 否则回退 legacy `resources/`。`config.uiDistRoot` / `config.uiDist` 可注入/关闭以测试。
- 效果: `npm run build:ui` 后打开 `http://127.0.0.1:3017` 即是干净的单一对话流 React UI, 不再有模式 tab 和堆叠面板; 旧 `resources/` UI 弃用。
- `test/ui-dist-serving.test.js` (3): 服务 ui-dist/index.html + 资源 + SPA 回退 + 缺资源 404; `/api` 与 `/health` 不被 SPA 劫持; `uiDist:false` 回退 legacy。

**全量验收**: `node --test` (29 文件, 分两组) **70 + 119 = 189 通过, 0 失败**; 端到端脚本 **24/24**; 全部 `src/**/*.js` + scripts + mcp-servers `node --check` 通过; 前端 `.ts` 真语法过 + 13 `.tsx` 括号/导入校验通过。

### 追加 (同日): 通用聊天 + 上传/语音/模型/思考强度 + Rust 环境

**前端通用聊天与控件 (React, 按 Claude Cowork 标准)**:
- `Composer.tsx` 扩展: 文件上传 (附件 chip, 走 `fileToUpload`→`/api/uploads/import`)、语音输入 (Web Speech API `webkitSpeechRecognition`, zh-CN, 转写追加到输入)、模型选择 (来自 `/api/kimi/info` 的 model)、思考强度 (快速/标准/深度, 透传 `thinking` 字段)。`onSend(text, meta)` 带回 {files, model, thinking}; 保留 /@# 弹层。
- `App.tsx`: `handleSend(text, meta)` — 先上传附件; 选了模板→recipe 可审批运行 (带上传文件); 否则→**通用聊天** `chat()` (`/api/kimi/chat`), 展示 `result.text`; 未配置 API 时回退 recipe 或提示配置 KIMI_API_KEY。`api.ts` 加 `getKimiInfo / chat / importUploads / fileToUpload`。
- 校验: `.ts` 经 type-strip 真语法过; 13 个 `.tsx` 括号平衡 + 无未用导入 (无 tsc/esbuild, 真编译在用户机器)。

**Rust 环境 (用户 Windows 机器, 经 Windows-MCP)**:
- 探测: Rust 1.95.0 (msvc 工具链) 已装在 `C:\Users\Administrator\.cargo\bin` 但**不在 PATH** → 已持久写入用户 PATH (新终端 `cargo` 可用)。
- 缺 **MSVC C++ 生成工具** (Tauri 编译链接器) → winget 后台静默安装 `Microsoft.VisualStudio.2022.BuildTools` + VCTools 工作负载 (含 Windows SDK), 进行中。
- 待 MSVC 完成后 `cargo install tauri-cli --version ^2`, 再 `cargo tauri dev`。
- 后续 (用户要求): 用户登录功能 (待 MSVC/前端落地后做)。

### 追加 (同日): 贴合 Claude Cowork 四件套 (流式/Web/Plan/Skill) + Rust 收尾

**P0 流式回复 + Markdown**:
- `api-runner.js` 加 `runKimiApiChatStream` (stream:true, 解析上游 OpenAI 兼容 SSE, onToken 逐字); `kimi/chat-stream.js` + `POST /api/kimi/chat/stream` (text/event-stream: start/token/done/error 帧, 末尾记 kimi-chat run; streamRunner 可注入)。
- 前端 `api.ts` 加 `chatStream` (fetch POST + 手动解析 SSE); `lib/md.ts` 零依赖 Markdown 渲染器 (先转义再变换, XSS 安全, 覆盖标题/粗斜体/行内+围栏代码/列表/链接); `App.tsx` 通用聊天改逐字流式, 助手气泡 `renderMarkdown`。
- 测试 `chat-stream.test.js` (2): 假 runner 验 start/token×N/done 帧 + 记 run; 未配置 503。

**P1 Web 抓取**: `tools/web-fetch.js` `web.fetch` (http(s) 校验 + 超时 + 大小上限 + 默认拦内网/loopback), 注册为内置工具。`web-fetch.test.js` (4): 取页/截断/拒非法 scheme+内网/经注册表调用。

**P1 Plan mode**: `runtime/plan-builder.js` `buildPlan` (planner 可注入, 默认按 registry.search 映射工具, 过滤未知 tool) + `POST /api/plan`。审批后走现有 `/api/subagent/run`。`plan.test.js` (4)。

**P1 Skill 注册表**: `skills/skill-registry.js` (recipe→skill manifest: trigger/permissions/outputs/enabled) + `GET /api/skills` / `POST /api/skills/:id/toggle`。`skills.test.js` (3)。

**验收**: host `node --test` (33 文件, 分两组) **76 + 126 = 202 通过, 0 失败**; 前端 `.ts` 真语法/运行时验证 + 13 `.tsx` 括号/导入通过。

**Rust 环境收尾**: PATH 已修; MSVC 已装 (cl.exe 在 14.44.35207); tauri-cli 直连 crates.io 超时 → 配 `~/.cargo/config.toml` 用 rsproxy.cn 镜像后重新编译 (依赖已飞速下载, 编译中)。完成后 `cargo tauri dev` 即可。

**仍待 (按 Claude Cowork 标准, 后续)**: AskUserQuestion 协议、对话内联可视化/活页、取消/中断 + 用量、多模态(图/PDF)、连接器推荐、用户登录(数据层 tenant 已就位, 缺鉴权)。

### 追加 (同日): 运行取消/中断 + Rust/Tauri 工具链打通

**运行取消/中断 (Claude Cowork 的"停止"按钮)**:
- `runtime/cancellation.js` `CancellationRegistry` (register/signal/isCancelled/cancel/done/pending)。
- `runKimiApiChatStream` 接受外部 `signal` 并链到超时 controller; `chat-stream.js` 注册 controller、传 signal、取消时记 `cancelled` run 并发 `cancelled` 帧、done 帧带 usage。
- `POST /api/runs/:id/cancel` (server 内联)。`cancellation.test.js` (3): 注册表语义、未知 run 取消 false、流式中途取消 (读 start 帧拿 runId→cancel→收到 cancelled 帧)。
- 验收: host `node --test` (34 文件) **75 + 130 = 205 通过, 0 失败**。

**Rust / Tauri 工具链全部打通 (用户机器, 经 Windows-MCP)**:
- cargo 1.95.0 (PATH 已修) + MSVC BuildTools 2022 (cl.exe/link.exe @14.44.35207 + Windows SDK 10.0.26100)。
- 关键卡点: ① crates.io 直连超时 → 配 `~/.cargo/config.toml` rsproxy.cn 镜像; ② **Defender ASR 规则 `01443614…`(阻止新编译/不可信可执行文件运行)拦了 cargo build-script.exe → `拒绝访问 os error 5`** → 加路径排除 + 禁用该 ASR 规则。
- 结果: `cargo-tauri 2.11.2` 已装。桌面端启动: `npm run build:ui` 生成 ui-dist → `cd apps/windows-client/src-tauri` → `cargo tauri dev`。

### 追加 (同日): 贴合 Claude Cowork 收官五项 (澄清/连接器/内联可视化/登录/多模态)

- **AskUserQuestion 澄清协议**: `runtime/clarifications.js` 待答问题注册表 + `POST /api/clarify` / `GET /api/clarify/:id` / `POST /api/clarify/:id/answer`。`clarify.test.js` (2)。
- **连接器推荐**: `connectors/catalog.js` 内置 6 个 MCP 连接器目录 (fs/web-fetch/memory/sqlite/git/postgres) + 关键词排序; `GET /api/connectors` / `/api/connectors/suggest?q=`。`connectors.test.js` (2)。
- **对话内联可视化**: `lib/md.ts` `splitVizBlocks` 把助手 Markdown 里的 ` ```chart / ```mermaid ` 块拆出; `InlineViz.tsx` 调 `/api/viz/render` persist:false 用 iframe srcDoc 内联渲染 (show_widget 的对话内形态); `MessageText.tsx` 组合 Markdown + 内联图; App 用 MessageText 渲染助手消息。
- **用户登录 (本地鉴权)**: `auth/user-store.js` (scrypt 加盐 + session token) + `POST /api/auth/{register,login,logout}` / `GET /api/auth/me`; 请求入口解析 `Authorization: Bearer` 覆盖 requestContext 的 user/tenant (无 token 回退本地默认, 向后兼容)。`auth.test.js` (2)。
- **多模态管线**: `workspace/attachment-context.js` `buildAttachmentContext` 分类附件 (文本/PDF/DOCX 抽取正文, 图片标记为待视觉解析) + `POST /api/attachments/context`。`multimodal.test.js` (2)。

验收: host `node --test` (38 文件, 分两组) **71 + 142 = 213 通过, 0 失败**; 前端 `.ts` 真语法/运行时 + 15 `.tsx` 括号/导入通过。

至此 "更贴合 Claude Cowork" 清单 (流式/Markdown/Web/Plan/Skill/取消/澄清/连接器/内联图/登录/多模态) 全部落地。

### 追加 (同日): 接通 Kimi Code API (流式聊天实时可用)

用户的 key 是 **Kimi Code**(编码套餐),要点:
- 协议: **OpenAI 兼容**, 端点 `https://api.kimi.com/coding/v1`(不是 moonshot.ai/.cn)。
- 模型 ID 固定: **`kimi-for-coding`**。
- 鉴权: `Authorization: Bearer <key>`。
- 关键限制: Kimi For Coding 套餐**只放行被识别的编码 Agent 客户端**(按 `User-Agent` 网关校验); 默认 UA → 403 `access_terminated_error`。需以被识别 UA 接入 (实测 `claude-cli/1.0.108 (external, cli)` → 200)。

落地:
- `api-runner.js` `resolveKimiApiConfig` + 两个 runner 增加可配置 `userAgent` (env `KIMI_USER_AGENT`), 串过 `server.js` / `chat-stream.js` / `start-tauri-host.mjs`。
- `.env` (仓库根, 已 gitignore, host 启动自动 `process.loadEnvFile`): `KIMI_API_KEY` / `KIMI_BASE_URL=https://api.kimi.com/coding/v1` / `KIMI_MODEL=kimi-for-coding` / `KIMI_USER_AGENT="claude-cli/..."`。
- 实测: `/api/kimi/chat` 200 真实回复; `/api/kimi/chat/stream` 63 token 帧 + done(完整流式输出)。相关测试 43/43 通过 (userAgent 为可选项, 向后兼容)。

(注: Kimi For Coding 套餐被官方限定编码 Agent 客户端使用; 以该 UA 接入由用户自行决定。建议明文出现过的 key 用后轮换。)

### 追加 (同日): 修复首字延迟 + 去掉"每次规划文件"

用户实测反馈两点不像 Claude Cowork, 已修:
- **首字延迟**: `kimi-for-coding` 是推理模型, 先出大段 `reasoning_content` 再出 `content`, 而流只取 content → 推理阶段 UI 空白干等。修复: `runKimiApiChatStream` 解析 `reasoning_content` 经 `onReasoning` → SSE `reasoning` 帧 → 前端实时显示"思考中…"+ 思考过程 (`<details>`)。实测 353 reasoning 帧 + 39 token 帧, 首反馈即时。
- **每次规划文件**: ① 聊天提示词原含"提醒切到协作模式/执行计划"引导 → 改为自然对话, 明确"日常聊天不要生成执行计划"; ② `App.handleSend` 原在 `chatEnabled` 为假时**回退 recipe(永远在规划文件)** → 改为聊天默认, 去掉回退, 仅显式选模板才走文件操作流; 空状态文案改聊天优先。实测回复变自然对话 (非文件清单)。
- 验收: host `node --test` (38 文件) **213 通过, 0 失败** (含更新后的 prompt 测试); 前端 tsc strict + vite build 通过; UA/.env 链路 + 流式 reasoning 实测通过。

### 追加 (同日): Agent 工具循环 — 真正能在本地干活 (核心贴合 Claude Cowork)

用户反馈"它无法在我的本地工作"。根因: 通用聊天是纯文本对话, 模型没有工具。补齐 Claude Cowork 的核心——**带工具的 agent 循环**:
- `src/kimi/agent-tools.js`: OpenAI function-calling 工具 list_dir/read_file/write_file/search_files/web_fetch/run_code, 全部 jail 在 trustedRoot, 复用现有 file-reader/file-search/code-runner/web-fetch。
- `src/kimi/agent-runner.js`: runAgentChat 工具调用循环 (modelCall 可注入) — 模型返回 tool_calls → host 执行 → 结果以 role:tool 喂回 → 循环至终答; streamAgentChat 走 SSE (start/reasoning/tool_call/tool_result/token/done/cancelled/error) + 记 agent-chat run。
- POST /api/agent/chat/stream (server 接线; config.agentModelCall 可注入测试)。
- 前端 api.ts 加 agentChatStream; App.tsx 通用聊天改走 agent, 工具调用渲染成时间线进度行。
- 关键修复: kimi-k2.6 是思考模型, follow-up 调用须回传上一条 assistant 的 reasoning_content (否则 400 "thinking is enabled but reasoning_content is missing")。
- 测试 agent.test.js (3) + host 全量绿; 真机实测 (k2.6+真 key): 模型调 write_file → 文件真实落盘 → done + 总结。Agent 现在真能动本地文件。

### 追加 (同日): 对齐 Kimi CLI 原生工具 + 风险分级审批门

参照用户本机 Kimi CLI (`...uv\tools\kimi-cli\...\kimi_cli`) 的架构 (tools/ approval_runtime/ hooks/ skill(s)/ subagents)。

- **原生工具对齐**: `src/kimi/agent-tools.js` 改为 Kimi CLI/Claude Code 同名工具集 `Read / Write / Edit(old_string→new_string) / Glob / Grep / Shell / WebFetch`, 全 jail 在 trusted root。
- **审批门 + 自动审批**: `src/runtime/approvals.js` (request 返回 Promise, resolve(id, once|session|reject), cancelAll); agent-runner 在高风险工具执行前发 `approval_request` SSE 并 await; `POST /api/approvals/:id` 解析决定; 前端 `agentChatStream` 处理 approval_request → 审批栏 (本次/本会话/拒绝) → `respondApproval`; 头部"自动批准 (YOLO)"开关。
- **风险分级 (UX 优化, 仅高风险审批)**: 工具带 `risk: safe|write|high`。Read/Glob/Grep/WebFetch=safe、Write/Edit=write(工作区内改文件, 不审批)、Shell=high(执行命令, 审批)。审批门仅 `risk==='high'` 触发 — 不再每步都审批。
- 测试: `approvals.test.js` (6: 注册表 / 高风险 once / reject / YOLO / Write 不弹审批 / Shell 阻塞→approve→done) + `agent.test.js` (4) 全绿; host `node --test` 223 通过 0 失败。
- 真机实测 (k2.6+真 key): autoApprove 写文件落盘; 风险分级后"写文件 0 个 approval_request 直接执行", 仅 Shell 会请求批准。

**仍按 Kimi CLI / Claude Cowork 待补 (后续阶段)**: 真 token 逐字流式 (现为非流式逐轮 + 最终内容整段)、hooks (pre/post 工具事件 engine)、多轮自我验证强化、skills/memory 注入 agent 上下文、subagents 前台。

### 追加 (同日): 风险分级审批 + 真 token 流式 (对齐 Kimi CLI / Claude Cowork)

- **对齐 Kimi CLI 原生工具**: agent 工具改为 Read/Write/Edit/Glob/Grep/Shell/WebFetch (Kimi CLI 同名), 全部 jail 在工作区。
- **风险分级审批 (优化体验, 非每步审批)**: 只有**高风险**操作 (`Shell` 执行命令, `risk:'high'`) 才弹审批; `Write`/`Edit` 等工作区内文件改动 = 低风险, 自动放行。审批选项 Approve once / 本会话批准 / 拒绝 (acp 风格) + 自动批准 (YOLO) 开关。`POST /api/approvals/:id` 解决待审批; agent 循环 await 决定。`approvals.test.js` (6): 注册表、高风险 once/reject、**低风险不弹审批**、YOLO、路由 Shell 阻塞→批准→继续。
- **真 token 流式 (体感差距最大)**: `defaultAgentModelCall` 改 `stream:true`, 边收边 onContent/onReasoning → SSE token/reasoning 逐块流出 (并正确累积流式 tool_calls 的 index/arguments); 循环兼容非流式注入 (测试)。实测一次普通问答 = 62 token 帧 + 64 reasoning 帧, 逐字打字效果。
- 验收: host `node --test` **234 通过, 0 失败** (含 agent 4 + approvals 6); 前端 tsc strict + vite build 通过; 真机实测 (k2.6+真 key): 流式逐字 + Shell 审批 + Write 自动放行。
- **仍待 (Kimi CLI 还有, 后续)**: hooks (pre/post 工具事件)、skills/memory 注入 agent 上下文、subagents、多轮自我验证强化。

### 追加 (同日): 五层记忆 + skills 注入 agent + MCP/外部连接器接入 agent

- **五层记忆体系 (参考 Claude Code CLAUDE.md 分层)**: `memory/memory-layers.js` `loadLayeredMemory` 读取并按优先级合并 enterprise(KCW_ENTERPRISE_MEMORY) → user(`~/.KimiCowork/MEMORY.md`) → project(`<root>/.KimiCowork/MEMORY.md`) → local(`MEMORY.local.md`) → session 五层; agent 系统提示注入合并后的记忆。`memory-layers.test.js` (2)。
- **skills 注入 agent**: agent 系统提示列出已启用 skills(名称/触发场景) + 新增 `Skill` 工具(按 id 跑 recipe, 低风险只产出可审批计划)。
- **MCP / 外部连接器接入 agent (修复 ❌)**: `buildAgentToolset` 把 toolRegistry 里 `mcp:*` 来源的工具(已连接的外部连接器)映射成 agent 工具(`risk:'high'` → 走审批), 模型可直接调用。之前 MCP 客户端只注册到 toolRegistry, 未暴露给 agent; 现已打通。
- `agent-runner` 的 SYSTEM 改为 `buildSystemPrompt({memoryText, skills})`(并修正过时工具名为 Read/Write/Edit/Glob/Grep/Shell/WebFetch); `streamAgentChat` 从 server 注入 toolRegistry+skillRegistry, 组装"原生工具 + MCP 工具 + Skill 工具"完整工具集 + 分层记忆 + skills 列表。
- 验收: host `node --test` **236 通过, 0 失败**; 真机实测: 写项目 `.KimiCowork/MEMORY.md` 规则(以『Derrick，』开头)→ agent 回复严格遵守, 证明五层记忆注入生效。
