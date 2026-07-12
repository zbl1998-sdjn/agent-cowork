# Changelog

All notable changes to this project will be documented in this file.

The format follows Keep a Changelog, and release versions use SemVer.

## [Unreleased]

## [0.4.0] - 2026-07-12

### Added

- 新增只读任务中心，复用 Host `/api/tasks` 汇总最近任务，支持搜索、状态筛选与显式刷新，并把任务入口接入左侧导航、命令面板和上下文运行记录。
- 任务详情新增 owner 隔离的产物版本链：父子 lineage、内容哈希校验、只读历史和显式“预览计划→确认发布”流程；新版本 write-once，不覆盖父版本。
- 新增统一权限模式(`plan` / `manual` / `guarded_auto`)；安全自动模式仅自动放行低风险工具，高风险操作仍由 host 发起显式人工审批，并把权限模式与模型 fallback 摘要写入运行归因。
- 定时任务面板支持选择已启用技能并创建 cron 周期或一次性任务，创建请求带幂等键并保留工作区边界。
- 新增加密的 Connected-folder grant 注册表、owner 隔离的撤销墓碑和 UI 侧 opaque grant ID 选择；每次工作区请求与调度执行均重新验证 active grant。
- 调度记录新增不可变运行 attempt 历史，严格解码并保留最近 20 次成功/失败结果；`lastRunId` 只在成功时更新。
- 新增只读受控能力包目录和安装计划：展示版本、发布者、必需包、权限、安全要求与 fail-closed 治理结论，解析传递依赖及继承权限，但不下载、安装、启用或执行第三方代码。

### Changed

- 本地 Host 未显式配置 `KCW_STORE` 时默认使用 SQLite 单文件持久化；`DATABASE_URL` 单独存在不会启用 PostgreSQL，`file` 与 `postgres` 后端仍需显式选择，PostgreSQL 缺少 `DATABASE_URL` 时会在启动期明确失败。

### Fixed

- Host 覆盖率与普通测试入口不再传入 Node 22.23.1 不识别的稳定版 `--test-isolation` 参数；继续依赖 Node 20+ 默认的逐文件子进程隔离，覆盖率解析同时兼容 Node 22 的 TAP `#` 与新版 reporter 的 `ℹ` 行标记，并为覆盖率插桩下的多进程架构夹具保留 120 秒单文件上限。
- 运行事件订阅在网络/Host 短暂中断后会携带 `Last-Event-ID` 进行有上限指数退避重连，按事件序号去重，并在终态主动关闭长连接；不可恢复响应或重试耗尽会显式报错。
- 任务展示不再把 `awaiting_approval` 与 `cancelled` 误报为“任务运行中”，失败记录也会在租户/用户隔离的任务复核面透传错误信息。
- 移除前端对高风险 `approval_request` 的自动代答，避免“自动执行”绕过人工审批语义。
- 高风险审批不再复用会话级缓存，恢复旧 checkpoint 时也不能借遗留缓存绕过逐次确认；单个与并行子 Agent 均继承父会话的计划模式。
- 审批、计划和提问只有在 Host 明确确认后才从时间线移除；失败项、风险等级和操作预览保持可见，批量审批也只清除已确认项目。
- `ScheduleTask` 现在必须绑定已启用的 `recipeId`；默认调度路由在创建与触发前双重复核，纯 prompt、未知或已停用技能均失败关闭。
- 定时 recipe 只生成 `awaiting_approval` 草案，不再把尚未获批的文件操作标成成功；创建重试复用稳定幂等键，取消/触发错误及最近运行信息会明确呈现。
- Agent SSE 与运行诊断记录统一脱敏，敏感参数不会经事件流或诊断落盘回显。
- 通用文件写入、原生 Write/Edit、rename 与 rollback 不再能修改或伪造不可变 live-artifact 版本；稳定哈希现在包含合法的 `__proto__` JSON 键。
- 产物发布及通用 file-ops 的幂等缓存命中前会重新验证 Connected-folder grant，并把规范化根目录纳入指纹，撤销后不再回放成功响应或绝对路径元数据。
- Connected-folder 注册表达到 10,000 条时会在写盘前失败关闭；UI 撤销成功后立即清理已撤销选择，即使刷新失败也不会恢复旧 grant。

## [0.3.0] - 2026-07-09

### Added(自带跨会话记忆——关闭 MASE 也可用,dogfood 2026-07-09)

- **对话缓冲(同会话连续性)**:`memory/conversation-buffer.ts` 每轮成功后把 `{role,text,ts}`(先 DLP 脱敏)append 到 `<root>/.AgentCowork/conversations/<convId>.jsonl`,按轮数(40)/字节(32KB)滚动;`agent-stream` 读缝把最近若干轮当 session 层注入。修好此前"关闭 MASE 后 Turn 2 完全不记得 Turn 1"(多轮记忆此前 100% 依赖 MASE)。
- **对话自动提炼主题知识**:切换对话时惰性触发,把上一对话交给模型(经 `decideEgressPolicy` 出站网关)提炼成结构化主题知识(`knowledge-extractor` 保守提取 + `consolidate` 编排)。知识库(`memory/knowledge-store.ts`,`.AgentCowork/knowledge.json`)带置信度门(高→active/低→pending 待确认)、按主题去重合并/supersede、per-scope 容量淘汰、DLP 拒密钥、来源溯源(sourceConversationId+ts)。
- **新对话相关性召回**:`memory/knowledge-recall.ts` 按当前 prompt 相关性(关键词/CJK 2-gram,零依赖)挑 top-K active 知识注入系统提示;不相关不注入(读侧防污染)、pending 永不召回。另加只读 `SearchMemory` agent 工具供按需深查。
- **记忆面板主题知识区**:`MemoryKnowledgeSection` 展示 active/pending,可批准 pending→active、删除误提炼条目;端点 `GET/POST/DELETE /api/memory/knowledge*`(`memory-knowledge-routes.ts`)。
- 真机端到端验收(MASE off + 真实 kimi-k2.6):对话→切换自动提炼→新对话召回全链路通过,证据存 `reports/memory-e2e/`。

### Fixed

- **长上下文压缩丢失注入记忆(问题B)**:`history-compactor` 超预算时会把承载 agent 指令+注入记忆的首条 system 消息折进摘要并尾截断,小窗口本地模型/超大 MEMORY.md 的长对话会丢长期记忆。修:压缩时保护首条 system 消息(只摘要其后历史、给其预留 token 额度),正常长历史下记忆完整、极端小预算下也优先保记忆。

## [0.2.1] - 2026-07-09

### Fixed(dogfood 全面遍历审查,2026-07-09)

- **主对话工具集的原生 WebFetch 绕过出站策略网关(P0)**:`/api/agent/chat/stream` 主对话实际暴露的是 `apps/host/src/kimi/agent-tools.ts` 里独立定义的原生 `WebFetch`(`toolset-builder` 只合并 `mcp:` 前缀工具,已网关化的 `web-builtin-tools.ts` 版进不了主聊天集),它 `mutating:false/risk:'safe'` 且直接裸调 `webFetch()`,`controlled_hybrid`/`enterprise_local` 下可无审批、无出站审计地把工作区内容发往任意公网 URL。补上 `decideEgressPolicy`/`recordEgressDecision` 前置检查并对齐风险字段为 `high/requiresApproval`。这是此前三处同类出站旁路(recipe/orchestrator/web-builtin)之外命中生产主路径的第四处。
- **图表/流程图/活页产物在桌面窗口内无法渲染(CSP 拦截)**:`InlineViz`/`LiveArtifactView` 把产物 HTML 塞进桌面应用 `sandbox="allow-scripts"` 的 `<iframe srcDoc>`,浏览器把外壳 CSP(`script-src 'self'`,无 `unsafe-inline`)继承给子文档且子文档 `<meta CSP>` 无法放宽(Playwright 实测确认),导致 CDN `<script src>` 与内联画图 `<script>` 全被拦、图表永远空白。改为本地打包 Chart.js/Mermaid 到 `public/vendor/`,画图逻辑移入外部脚本,数据经 `<script type="application/json">` 传递,消除全部内联可执行脚本;`air_gap` 行为不变。以真实产物 HTML + 真实 vendor + 真实 CSP 端到端验证渲染正常。
- **设置→组件面板对内置 Python、中日韩字体、WebView2 误报缺失/待检测**:三处探测都只认环境变量,不看随包实际落盘/系统实际安装。改为实地探测回落——内置 Python 探测 host exe 同级 `python-embedded/python.exe`;CJK 字体回落探测系统字体(与 PDF 渲染同口径);WebView2 探测标准安装目录。真机验证三项核心组件均识别为可用,核心异常计数从 2 降到 0。显式 env 配置仍优先,真正缺失时仍正确报缺失。

### Chore

- 删除三个全仓库零引用、零测试的孤儿模块:`storage/json-store.ts`、`hooks/usePromptRefine.ts`、`lib/api/capabilities.ts`(后端 `/api/capabilities/*` 路由本身保留)。

### Security(dogfood 全量安全审计,PR #22–#33)

- **CSV 公式/DDE 注入(OWASP CSV Injection)**:`csvOperation` 只转义 `",\r\n`,不防公式。`=cmd|'/c calc'!A1` 等原样写入 CSV,Excel 打开即执行任意命令。修:公式前缀单引号中和,合法负数/科学计数不误伤。
- **AI recipe 绕过机密档出网闸门**(3 处叠加,均已堵上):recipe AI 提取(`model-recipe-extract.ts`)、orchestrator 编排任务(`provider-task-runner.ts`)、内置 `web.fetch`/`WebSearch` 工具,此前均直接裸调而不经 `decideEgressPolicy`,`air_gap`/`local_strict` 下仍会实际出网。三处统一补上出站策略检查,deny 时优雅回退模板/抛错,`controlled_hybrid` 等默认模式不受影响。
- **OOXML 控制字符致文档损坏**:源数据含 NUL/响铃等 XML 非法控制字符时,生成的 Word/PPT/Excel 是非法 XML,Office 报"文件损坏无法打开"。修:写入前按码点剥离非法控制字符,保留 `\t\n\r`。
- **可视化产物 CDN 依赖违反零出网承诺**:图表(Chart.js)/流程图(Mermaid)产物内嵌外部 CDN `<script>`,机密模式下打开文件仍会真实出网。修:`air_gap` 下退化为纯 HTML 表格/原始定义文本,不引入任何外部脚本,并显示可见说明横幅。
- **沙箱严格模式策略未被消费**:`local_strict`/`air_gap` 下无隔离沙箱后端时,`policyBlocked` 只写进展示字段从未真正阻止 `sandbox.exec`/`sandbox.run-code` 注册(定级 P2/P3——调用层 `decideToolPolicy` 独立防线本就正确 fail-closed deny)。修:注册层也据此排除这两个高风险工具,并把散落的 `local_strict` 单点判断统一成 `isStrictLocalMode`(覆盖 local_demo/local_strict/air_gap)。
- 凭据存储非 Windows 平台 fallback 密钥(`hostname:username:homedir` 派生)缺少可见性,现在首次触发时输出警告日志,提示设置 `KCW_CREDENTIAL_KEY`。

### Added(AI 驱动的办公 recipe,PR #16–#21、#30)

- 6 类内置 recipe(会议纪要转行动项、总结报告、合同摘要、反馈聚类、一键周报、表格清洗)接入模型驱动的结构化提取:有模型配置时先尝试 AI 语义提取,提取失败/无模型/出站策略拒绝时优雅回退现有模板,不破坏离线可用性。真实 Ollama 验证:会议纪要正确识别负责人/待办/截止,反馈聚类做到语义聚合(而非正则重排)。
- 定时任务(scheduler)现在复用与手动运行相同的 AI recipe 路径,不再永远走模板。
- 产物预览新增「✨ AI 生成」标识,区分模型提取产物与模板兜底产物。

### Fixed(dogfood 真机验收,PR #7–#15、#22–#24)

- Ollama/本地模型 provider 遮蔽导致的 404 与晦涩错误信息,改为可操作的"请确认本地模型正在运行"提示。
- 中文 PDF 从乱码占位改为真实 CJK 字体子集嵌入(CIDFontType2),Chrome 视觉验收中文正确渲染。
- 「引用本地文件」选中的源文件此前未进入 recipe 的 files 参数,导致需要来源材料的 recipe 报"引用 0 个";聊天模式下 @ 提及同样缺失,agent 会先对 `@文件名` 发起必然失败的 Read。两条路径均已把真实路径贯通进请求上下文。
- 思考模型(qwen3/deepseek-r1)的 `<think>` 推理块污染 JSON 提取,AI recipe 偶发回退模板;提取前先剥离推理块。
- 新建对话未切回对话视图、可视化项目成功计数漏算、流式响应未采集 token 用量等多项 UI/UX 缺陷。

### Added (2026-07-07 — 企业机密档安全基线 plan/08)

- 机密模式一键总开关 `KCW_CONFIDENTIAL=1`(L0 `security/confidential.ts`):`resolveSecurityMode` 强制返回 `air_gap` 且不可被任何配置/env 削弱(fail-closed);启动期 MCP(含 MASE)全丢、`/api/connectors/oauth/*` 一律 403、云模型/外网工具全部拒绝、本地 provider 仍可用;`/api/selfcheck` 暴露 `security.confidential`。
- 落盘加密(切片 2):可复用的 at-rest 信封(`security/at-rest.ts`)——随机 DEK 走 AES-256-GCM,DEK 只被 DPAPI(Windows)/环境派生密钥封印一次存 `.AgentCowork/security/at-rest.key`,避免每次写盘拉 PowerShell。开关 `KCW_ENCRYPT_AT_REST`(机密模式自动开),透明接入对话正文、运行记录、run/orchestrator checkpoints、长期记忆(MEMORY.md/笔记),读侧兼容遗留明文、开不了的密文按损坏跳过。附带修复 DPAPI 在 Windows PowerShell 5.1 下 `TypeNotFound`(缺 `Add-Type -AssemblyName System.Security`),该修复同时让连接器凭据存储在 5.1 环境可用。kimi apiKey(含 fallbacks)从明文落盘改为封印落盘。
- 数据生命周期(切片 2):工作区数据一键彻底销毁 + 保留期。`POST /api/security/data/purge-plan`(只读预览)、`/purge`(需 `confirm:true`,scope: conversations|runs|memory|content|everything,jail 固定服务端 `.AgentCowork`)、`/retention`(删除超 N 天的 run/对话 JSON)。计划先行 + 逐目标复核 jail,被篡改越界的计划抛错拒绝。
- OS 级出网强制(切片 3,计划模块):`security/egress-firewall.ts` 生成"对 app 进程树 program-scoped 出站 Block + loopback/内网网关 Allow"的可审查 Windows 防火墙规则计划(`npm run security:egress-firewall-plan`),含建规命令与一把回滚;非 IP 网关主机名不静默放行(要求 DNS pin)。诚实边界:Windows 防火墙 Block 优先于 Allow,纯规则无法完美"默认拒绝仅放行白名单",本切片为 best-effort OS 强制、应用层出口网关仍是主执行点;真机 apply + 零出网探测证据标"待验收"。
- 连接器治理(切片 4):机密档下连接器攻击面由三道闸锁死(启动 MCP 全丢 + OAuth 403 + connect 只接受本地 filesystem 内置),消除客户端注入任意 stdio 连接器出网的旁路;确认测试 `confidential-connector-posture.test.ts`。CA/EV 代码签名与外部渗透测试需外部条件(证书/第三方),已在 `plan/08` 标"待外部"。

### Added (2026-07-06 — agent runtime convergence & context window)

- Model-aware automatic history compaction: when a request does not pin `maxContextTokens`, the compaction threshold now adapts to the selected model's context window (conservative per-family floors, capped at 2M) instead of a hardcoded 12k. Local/BYO gateways (Ollama, LM Studio, custom OpenAI-compatible) do not get a guessed window (real `num_ctx` is unknowable from the model name and over-guessing risks overflow); declare it via `KCW_MODEL_CONTEXT_WINDOW` / per-request `contextWindowTokens`. Verified end-to-end through the real HTTP route against a real Ollama model.
- Auto-continue for oversized single-message tasks: when a turn runs out of its per-turn step budget while still working, the loop auto-extends by another window up to a hard cap `maxSteps*(1+maxAutoContinues)` (default 2 → up to 3 windows; `KCW_MAX_AUTO_CONTINUE` / `body.maxAutoContinues`, budget/timeout/loop/approval guards still apply). If even the hard cap is not enough, the run reports `stepsExhausted` and the UI surfaces a 继续 entry that resumes from the checkpoint without replaying completed writes. Verified with real Kimi (`kimi-k2.6`): a 10-step chain that used to be cut off at the 6-step budget now finishes naturally.
- Configurable convergence guardrails: a tool-use discipline block in the system prompt (batch parallel calls, stop when done, don't repeat) and a one-shot step-budget wrap-up reminder at ~70% of the budget. Both default-on and tunable/disable via `KCW_TOOL_DISCIPLINE` / `KCW_STEP_NUDGE_RATIO`. Real Ollama + Kimi A/B evidence archived under `reports/step-convergence/` (finding: capable models already converge, so these are zero-cost guardrails rather than a measured step reduction).

### Changed

- Marked the current Windows distributable and desktop shell as `Internal Beta` for small-circle testing, keeping production-release claims blocked on code signing, updater publishing, clean tag release, and external release evidence.
- Added a friend-test zip package with a Windows install guide, bundled installer SHA256, and beta scope notes for safer small-circle distribution.
- CI (`.github/workflows/ci.yml`) now runs the full local static gate (`npm run check` — arch/filesize/secrets/all TS type-checks/lint/ui-types/ts-coverage/js-boundary/icons) and a new UI unit-test job, instead of a narrower subset, so the local gate is no longer the only safety net.
- Documented the `services/` + `apps/local-agent` Go code as a frozen v1.0 pre-research skeleton that is not part of any build/CI (see `plan/00`), to remove architecture ambiguity.

### Added (2.x milestone, backfilled 2026-07-04 — see `git log` for individual commits)

- Optional MASE MCP long-term memory bridge integrated into the main agent chat stream: layered recall (thread timeline + structured facts + cross-session history) on read, write-back with fact extraction on success, 2.5s hard recall timeout with safe no-memory fallback.
- Local security posture engine: five security modes (`local_demo` / `local_strict` / `enterprise_local` / `air_gap` / `controlled_hybrid`) plus a unified outbound egress gateway for model calls, WebFetch, WebSearch, connectors, and plugin downloads, with an audit trail (`.AgentCowork/security/egress-audit.jsonl`) and a frontend security status bar showing the active mode and bytes egressed.
- Multi-provider model catalog (14+ OpenAI-compatible/Anthropic-compatible providers, including major domestic model providers) with per-session BYO-key overrides and a serial fallback chain with per-`provider|baseUrl|model` circuit breakers; cost attribution by provider.
- Beginner-friendly one-click office recipes (weekly report draft, boss summary, chat-to-action-list, PPT draft, formal Word doc, email draft) producing Markdown/DOCX/XLSX/PPTX/PDF, plus "save this run as my recipe" capture for custom recipes.
- Parallel sub-agent dispatch (`/api/subagent/parallel`, `AgentParallel` tool) alongside the existing single sub-agent route, each with independent context budgets and step limits.
- Agent runtime resilience: loop guard (repeated-call/consecutive-failure breaker), bounded retry for transient errors, budget guard (token/cost/wall-clock hard limits), whole-run timeout, streaming-interrupt recovery, checkpoint/resume (crash-safe, does not replay completed writes), and an injection guard that wraps tool output as untrusted data and flags prompt-injection/tool-hijack/exfiltration/approval-bypass patterns.
- Deterministic eval framework: golden + red-team task sets, offline replay backend (ModelRecorder/Replayer), fail-closed without explicit replay records.
- Observability: automatic run metrics (token/cost/duration/tool/failure-rate), provider/version/config attribution, structured decision trace, and a frontend Observability panel.
- Runtime dependency manager covering SQLite, embedded Python, Node, CJK fonts, VC++ runtime, Chromium, OCR (Tesseract Chinese packs), Pandoc, MinGit, ffmpeg, and data-science components; only produces reviewable install/cleanup/update plans, never silent downloads or deletes.
- Beginner Home UI ("今天想完成什么" task cards) replacing the earlier dual-page conversation/collaboration model; the primary send path moved to the SSE `/api/agent/chat/stream` endpoint.
- Full `apps/host` source migrated from JS+JSDoc `checkJs` to native TypeScript (0 remaining `.js` sources under `apps/host/src`, 293 `.ts` files).

### Security (2026-07-04)

- Fixed a Windows filename-equivalence bypass of the sensitive-file guard in `path-policy` (trailing dot/space, NTFS alternate data stream `name::$DATA` were not normalized before the sensitive-basename match).
- Fixed `classifyToolRisk` missing the actual `WebSearch` tool name (it only matched the `web.fetch` family), which let `WebSearch` bypass the `local_strict`/`air_gap` "block external network tools" policy and still reach DuckDuckGo/Bing.
- MASE memory bridge writes (user log / assistant log / extracted facts) now go through the same DLP guard as built-in memory; credential/secret-bearing content is skipped rather than written to the external memory backend.
- Memory recalled from any backend is now redacted before injection into the model system prompt, as defense in depth against secrets stored before the write-side guard existed.
- Memory pause/incognito settings now gate both built-in layered memory and the MASE bridge consistently on the live chat path (previously only gated the settings-panel API, not the agent run itself).

### Added

- Added P2-A sandbox startup probing: Docker/WSL are detected at host boot, Docker is selected automatically when a configured image is present locally, and local fallback is reported through `/api/sandbox/info` and `/api/selfcheck`.
- Added a gated real Docker integration test for `--network=none` outbound network blocking (`KCW_SANDBOX_REAL_DOCKER_IMAGE=<local-image-with-sh-wget>`).
- Added a real React connectors smoke test that opens the connector panel, one-click connects the builtin filesystem MCP server, and verifies the imported `mcp__fs__read_text` tool.
- Added connector disconnect support so host-defined MCP connectors can be revoked and their imported tools removed from the registry.
- Added a GitHub OAuth device-flow connector prototype with server-side device-code sessions, protected credential storage, redacted status/revoke routes, and React connector-panel start/complete/revoke controls.
- Added OAuth connector permission approvals: allowlisted scopes, single-use approval receipts, high-risk scope labels, and React connector-panel approval controls.
- Added live artifact connector data sources for connected filesystem MCP reads, with tests for disconnected and high-risk connector tool rejection.
- Added sub-agent context-budget enforcement so over-large plans are rejected before any tool runs, while direct sub-agent routes remain read-only/approval-isolated.
- Added parallel sub-agent dispatch via `/api/subagent/parallel` and the `AgentParallel` model tool, including aggregate run records, configurable concurrency, child context budgets, and approval-gated route rejection.
- Added child-agent lifecycle events and React subtask grouping for `AgentParallel` runs.
- Added local Office artifact generation for `summary-report` recipes (DOCX/PPTX/PDF alongside Markdown) and explicit artifact kinds for Word, spreadsheet, presentation, and PDF outputs.
- Expanded the host `checkJs`/JSDoc type guard to cover live artifact specs, viz rendering, OAuth permissions, JSON stores, and the tool registry.
- Added the local `npm run ci` gate for architecture checks, file-size checks, host tests, and UI tests.
- Added a dry-run-first release skeleton for SemVer validation, VERSION planning, git bundle planning, installer signing/archive planning, and tag planning.
- Added testing and release checklist documentation for milestone gates.

## [0.2.0] - 2026-05-25

### Added

- Archived the P0 + FE-1 Windows release under `releases/v0.2.0/` with NSIS, MSI, VERSION, source bundle, manifest, and installed Tauri smoke evidence.

### Fixed

- Made the Windows signing script discover the current `Agent Cowork_*` installer names instead of hard-coding `0.1.0`.

## [0.1.0] - 2026-05-24

### Added

- Baseline local Agent Cowork MVP release snapshot under `releases/v0.1.0/`.
