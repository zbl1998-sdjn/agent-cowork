# Agent Cowork

[![CI](https://github.com/zbl1998-sdjn/agent-cowork/actions/workflows/ci.yml/badge.svg)](https://github.com/zbl1998-sdjn/agent-cowork/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![Tests](https://img.shields.io/badge/tests-host%20995%20%2B%20ui%20359-brightgreen)
![Host Coverage](https://img.shields.io/badge/host%20coverage-94.36%25-brightgreen)
![Security](https://img.shields.io/badge/red%20team-no%20high%20severity-success)
![License](https://img.shields.io/badge/license-MIT-blue)

一个生产级 Agentic Cowork 系统，让 AI Agent 真正帮你完成本地文件操作、代码执行和跨工具协作任务。

**核心能力：**
- **Agentic tool-calling loop**：模型自主决策调用 Read/Write/Edit/Glob/Grep/Shell/WebFetch 工具，多步完成复杂任务
- **Plan Mode**：生成可审批的执行计划，用户批准后才执行写操作
- **MCP 协议栈**：完整四层实现（StdioTransport → JsonRpc → McpClient → connect），命名空间 `mcp__<server>__<tool>`
- **生产级稳定性**：CircuitBreaker 三态机（closed/open/half-open）+ Token Bucket 限流 + ApprovalRegistry TTL 防挂起
- **双存储后端**：SQLite（单机）/ PostgreSQL（多实例，含 LISTEN/NOTIFY 跨实例 approval）
- **长期记忆桥接（可选，MASE）+ 内置分层记忆**：内置五层记忆（企业/用户/项目/本地/会话）默认注入；可选接入外部 MASE MCP 记忆后端（独立仓库，不随本仓库分发），每轮开始注入「本线程最近对话 + 当前结构化事实 + 跨会话相关历史」，每轮结束写回并抽取结构化事实；召回硬超时 2.5s，未配置或超时一律安全降级为不带记忆，不阻塞对话。所有记忆写入统一过 DLP 分级拒绝疑似凭据（API key/token/密码），注入模型前再做一次读侧脱敏兜底（历史遗留旧密钥也不会被回放进上下文）；记忆暂停/隐身开关对内置记忆与 MASE 桥接一致生效
- **安全护城河 / 出口治理**：5 档安全模式（`local_demo`/`local_strict`/`enterprise_local`/`air_gap`/`controlled_hybrid`）+ 统一出站网关对模型调用/WebFetch/WebSearch/连接器/插件下载做策略判定与审计留痕（`.AgentCowork/security/egress-audit.jsonl`），前端安全状态条实时展示当前档位与「外发 N B」；工具风险分类（`network_external`/`sandbox_exec`/`connector`/…）让 `local_strict`/`air_gap` 下自动拦截对外网络工具（含 WebSearch）与非网络隔离沙箱执行
- **多 Provider 目录**：内置 14+ 家 OpenAI-compatible / Anthropic 兼容 provider（Kimi/Moonshot、DeepSeek、通义千问、智谱 GLM、火山方舟、百度千帆、腾讯混元、MiniMax、讯飞星火、硅基流动、OpenAI、Anthropic/Claude、Ollama、LM Studio、自定义 OpenAI-compatible），支持会话级 BYO-key 覆盖与串行 fallback 降级（按 `provider|baseUrl|model` 粒度熔断，成本按 provider 归因）
- **一键办公配方**：内置周报草稿、给老板看的一页总结、聊天转行动项清单、PPT 初稿、正式 Word、邮件初稿等配方，产出 Markdown/DOCX/XLSX/PPTX/PDF；支持把一次真实操作「存成我的配方」复用
- **子代理**：`/api/subagent/run`（单个，只读/低风险直跑，写入型仍走审批）与 `/api/subagent/parallel` + `AgentParallel` 工具（并发派发多个子任务，各自独立上下文预算/步数上限，子任务生命周期事件前端分组展示）
- **Agent 运行时韧性**：LoopGuard（重复调用/连续失败打断）、有界重试（仅对可重试错误退避）、BudgetGuard（token/成本/wall-clock 硬上限）、整轮超时、流式中断保留已生成内容、Checkpoint/Resume（可从崩溃点续跑、不重放已完成写操作）、InjectionGuard（工具输出包成不可信数据块，检测提示注入/工具劫持/数据外泄/审批绕过模式）
- **可观测性 + 确定性评测**：每次 run 自动带 token/成本/耗时/工具/失败率与决策 trace，前端可观测面板可查历史 run；`npm run eval` 跑 golden + 红队任务集，走离线回放后端（ModelRecorder/Replayer），默认必须提供 replay records 才回放（缺失 fail-closed）
- **运行时依赖管理**：设置页展示 SQLite / 内置 Python / Node / CJK 字体 / VC++ 运行库 / Chromium / OCR（Tesseract 中文包）/ Pandoc / MinGit / ffmpeg / 数据分析组件等的可用性，只生成可审查的安装/清理/更新计划，不静默下载或删除
- **定时任务**：cron 5 段或一次性 `fireAt` 调度执行配方/工具
- **安全边界**：path-policy trusted root jail + 敏感段黑名单（含 Windows 文件名等价/NTFS ADS 归一，防绕过）+ symlink 解析 + redaction 脱敏 + JWT 鉴权（HS256 锁定 + timingSafeEqual）+ 出站 SSRF 守卫（解析后 IP 判定 + 逐跳重定向复核）+ Host 头白名单（防 DNS-rebinding）+ 全链路 `shell:false`
- **小白友好前端**：首页「今天想完成什么」任务卡（周报/表格急救/PPT/会议纪要等常见场景），安全状态条实时展示当前安全档位与外发字节数，专家术语（MCP/Provider/Shell 等）默认不出现在小白视图
- **全栈**：Node.js 后端 + React/TypeScript 前端 + Tauri 2 桌面端 + Node SEA 打包

**测试覆盖：**
- Host：`npm run test:host:coverage:90` 通过（995 tests，994 pass，1 skip，0 fail），Node 内置 test runner + V8 coverage，line 94.36%，branch 78.75%，function 95.32%，`fail-under=90` 已生效；机器可读摘要提交在 `reports/coverage/host-coverage-summary.json`，文本报告和 V8 原始数据本地写入 `reports/coverage/host-coverage-latest.txt` 与 `reports/coverage/host-v8-*`，不依赖 Python/pytest/pytest-cov。
- UI：`npm run test:ui` 通过（78 个测试文件 / 359 个测试用例）。
- 仓库门禁：`npm run check` 通过，覆盖架构、secrets、host/root/script/ui 类型、lint、JS/TS 边界、TS project coverage、language service 与 icons。
- 覆盖面包括：circuit breaker、rate limiter、approvals 硬化、path-policy、MCP 协议、PostgreSQL 适配层、SSE 断连与 Last-Event-ID、tenant scope、路径 jail、OAuth 凭证流、沙箱、出站 SSRF 守卫与 Host 头白名单等。

**已知限制：**
- Host 启动时会探测 Docker/WSL。设置 `KCW_SANDBOX_DOCKER_IMAGE` 指向一个本地已有镜像后，如果 Docker daemon 和镜像都可用，默认选择 Docker VM 后端，并用 `--network=none` 执行 sandbox 工具。
- 本地后端（`LocalSubprocessSandbox`）运行在宿主机普通子进程中，Windows 无按进程网络命名空间，`networkIsolated === false`。当 Docker/镜像不可用时会回退本地，并在 `/api/sandbox/info`、设置页自检里明确提示“本地不隔离网络”。WSL 会被探测但默认不声明网络隔离保证。
- 真实 Docker 联网阻断验收可用本地镜像运行：`$env:KCW_SANDBOX_REAL_DOCKER_IMAGE='postgres:16-alpine'; npm run test:host`；本机已用该镜像验证 `--network=none` 下访问 `1.1.1.1` 返回 `Network unreachable`。

## 快速开始

```powershell
cd "C:\Users\Administrator\Desktop\agent cowork"
npm run demo:mvp
```

面试展示建议先看 [docs/面试演示配置说明.md](docs/面试演示配置说明.md):里面按架构讲法、`.env.example` 配置项、演示命令和验收口径整理了可直接讲的材料。真实 API key 只写本地 `.env`,不要提交。

`npm run demo:mvp` 是当前 Web/Host MVP 的一键演示验收入口：如果没有健康的 MVP 运行态，它会在后台启动 `start:mvp` 并打开页面；随后运行 live 操作测试、默认验证、Windows readiness 只读检查和总审计，最后写出 `build/mvp-demo-report.json`。

> **当前生产验收口径**：真正把关合并/发布的门禁是 `python -X utf8 scripts/quality_gate.py --level full`（委托 `security:local-strict` → `build:ui` → `smoke:playwright-all`（真机浏览器全链路）→ `npm run ci`（`check` + `test:host` + `test:ui` + `eval`））。下面这份手动分步命令列表来自更早的 MVP 阶段，命令仍可运行，但已不是当前的权威验收顺序；桌面安装版验收见 `npm run smoke:installed-tauri`。

手动拆分执行时（历史 MVP 阶段的验收顺序，命令仍可用，供逐项排查参考）：

```powershell
npm run start:mvp
npm run smoke:live-mvp
npm run smoke:plan-loop
npm run build:ui
npm run smoke:react-scroll
npm run smoke:react-connectors
npm test
npm run verify:mvp
npm run verify:windows-readiness
npm run audit:mvp
npm run smoke:rendered-ui
npm run smoke:windows-resources
npm run smoke:kimi-api
npm run smoke:mvp-runtime
npm run smoke:ui
npm run smoke:host
```

Host 测试使用 Node 内置 test runner；覆盖率用 `npm run test:host:coverage:90` 走 Node/V8 coverage，不依赖 Python/pytest 工具链。Windows sandbox/Defender 可能阻止测试子进程或 esbuild 子进程并报 `spawn EPERM`，这种情况需在正常本机权限上下文重跑同一命令确认真实结果。
`npm run smoke:ui` 会验证前端入口、关键 UI 控件、前端脚本使用的 Host API 路由，以及和页面一致的 workspace / tree / read / preview / apply / audit 操作链。
`npm run smoke:rendered-ui` 会用本机 Edge/Chrome 的 DevTools 协议启动临时 headless 浏览器，真实打开 Agent Cowork、检查 1536x900 和 1366x768 布局、点击发送和审批，确认执行动态信息流显示用户指令、读取上下文、等待审批和执行完成，确认前台任务卡片新增并高亮最新 run，并确认 artifact / audit 已落盘；报告和截图写入 `build/rendered-ui-smoke-report.json` 与 `build/rendered-ui-smoke-1536x900.png`。
`npm run smoke:react-scroll` 会启动临时 Host API，真实加载构建后的 React UI，预置长对话并发送一条流式回复，确认用户翻看历史时不会被新内容拽回底部，且“回到底部”按钮可出现并返回底部；报告和截图写入 `build/react-scroll-smoke-report.json` 与 `build/react-scroll-smoke-1280x760.png`。如果刚改过 React UI，先运行 `npm run build:ui`。
`npm run smoke:react-artifacts` 会启动临时 Host API，真实加载构建后的 React UI，预置 `.AgentCowork/artifacts` 产物，打开“产物”面板并执行重命名，确认 UI 与磁盘文件同步更新；报告和截图写入 `build/react-artifacts-smoke-report.json` 与 `build/react-artifacts-smoke-1280x760.png`。如果刚改过 React UI，先运行 `npm run build:ui`。
`npm run smoke:react-connectors` 会启动临时 Host API，真实加载构建后的 React UI，打开“连接器”面板，一键连接内置文件系统 MCP，确认 `mcp__fs__read_text` 进入工具 registry，再断开并确认工具被撤销；同一 smoke 还会用本地 mock GitHub device-flow 跑通 OAuth scope 审批、开始授权、完成授权、凭证状态查询和撤销，并确认凭证文件不泄漏 access token。活页后端也支持用已连接的受控 connector tool 作为数据源刷新，并用 host 测试覆盖未连接/高风险工具拒绝。报告和截图写入 `build/react-connectors-smoke-report.json` 与 `build/react-connectors-smoke-1280x760.png`。如果刚改过 React UI，先运行 `npm run build:ui`。
`npm run smoke:live-mvp` 会读取当前 `build/mvp-runtime.json`，直接打开正在运行的 MVP URL，完成发送/审批，确认执行动态信息流包含 Kimi 计划和审批状态，确认前台任务卡片显示最新 Cowork run，并确认当前 runtime workspace 里新增 artifact 且 audit 增长；报告和截图写入 `build/live-mvp-smoke-report.json` 与 `build/live-mvp-smoke-1536x900.png`。
`npm run smoke:plan-loop` 会启动临时 Host API，用脚本化模型跑一次计划模式闭环：只读研究两个文件、提交计划、审批后写两个产物、触发自检读回、最后收尾；报告写入 `build/plan-closed-loop-smoke-report.json`，用于覆盖 P1-A3 的本地可复现验收。
`/api/subagent/run` 和 `/api/subagent/parallel` 是 P1-B 子代理执行接口:只允许直接执行无需审批的只读/低风险工具,高风险/写入型工具仍必须走 agent 审批流;每个子代理计划有独立上下文预算和步数上限,超预算会在任何工具运行前返回 413。主 agent 也可通过低风险 `AgentParallel` 工具并发派发多个子任务,按子任务返回摘要并受最大任务数、并发数和上下文预算约束;并行子任务的 `child_start/child_end` 生命周期事件会在前端执行动态里分组展示。
`summary-report` recipe 会在 trusted root 下生成 Markdown、DOCX、PPTX 和 PDF 产物;DOCX/PPTX 走本地 OOXML ZIP writer,PDF 走本地轻量 writer,产物面板会把 `.docx/.pptx/.xlsx/.pdf` 分别标记为 Word/演示/表格/PDF 类型并继续复用现有打开链路。
`npm run smoke:windows-resources` 会用 headless Edge/Chrome 通过 `file://` 直接加载 Windows C 客户端资源，验证截图风格、1366x768 边界和静态预览/审批交互；它不会启动 `AgentCowork.exe`，因此可在 Defender ASR 阻塞 exe 时继续提供资源级验收。
`npm run smoke:kimi-api` 会启动一个临时 Host API，真实调用 Kimi/Moonshot OpenAI-compatible API，验证 `/api/kimi/plan` 可以基于 Host 提供的本地摘要生成中文计划，并落盘 `.AgentCowork/runs/*.json` 运行记录。该 smoke 依赖 `KIMI_API_KEY` 或 `MOONSHOT_API_KEY` 和可用网络，不放进默认 `verify:mvp` 的运行项。
`npm run smoke:mvp-runtime` 会启动一个临时 MVP 服务、检查健康状态和 runtime 文件、调用 `status:mvp`、调用 `stop:mvp`，确认本地产品入口可被明确启动和关闭；报告写入 `build/mvp-runtime-smoke-report.json`。
`npm run smoke:host` 会启动本地 host API，验证前端入口、默认工作区 API、文件树、文件读取、上下文打包、write / rename / move preview、审批 apply、目标已存在阻止和 JSONL 审计。
`npm run verify:mvp` 会聚合语法检查、Node 单测、Host 操作 smoke、MVP runtime smoke、UI contract smoke、rendered browser smoke 和 React 滚动 smoke，并把可审计报告写到 `build/mvp-verification-report.json`。如果已经在 Defender/企业 ASR 策略中放行 Windows 客户端精确 exe 路径，可以运行 `node scripts/run-host-node.mjs scripts/verify-mvp.ts --windows-client` 把原生窗口级 smoke 纳入 `build/mvp-verification-report-windows.json`。
`npm run audit:mvp` 会读取当前 runtime、verification、rendered UI、live MVP、runtime smoke、Windows 资源 smoke 和 Windows readiness 证据，汇总到 `build/mvp-acceptance-audit.json`；默认会在 Web/Host MVP 已就绪但原生窗口 smoke 被 Defender ASR 阻塞时正常生成报告，`npm run audit:mvp -- --strict` 会把任何未完成的完整目标作为非零退出。
`npm run verify:windows-readiness` 是只读检查：它不会修改 Defender，只会检查 `AgentCowork.exe` 是否存在、是否已有精确 ASR-only 路径排除项、普通目录级 exclusion 是否仍被 ASR 绕过、最近是否有 ASR 阻断事件，并写出 `build/windows-client-readiness.json`。
`npm run start:mvp` 会创建 `build/mvp-workspace` 演示工作区，启动本地服务并打开 Agent Cowork UI。
`npm run status:mvp` 会读取 `build/mvp-runtime.json` 并检查 PID 与 `/health`；`npm run stop:mvp` 会根据 runtime 文件停止由 `start:mvp` 启动的服务。

`npm run start:mvp` 默认监听 `http://127.0.0.1:3017`(与 Tauri sidecar 同端口;`npm start` 走 `main.ts` 默认 `3001`),并直接服务 Agent Cowork 前端工作台。页面会调用同源 Host API 读取 trusted root、列出本地文件、生成写入型操作预览,并在审批后写入 `.AgentCowork/artifacts/`。如果端口被占用,用 `PORT` 覆盖;trusted root 可用 `TRUSTED_ROOT` 覆盖。

模型回复功能默认只在配置了 provider API key（或本地 `ollama`/`openai/local` 无需 key）后启用，避免普通 MVP 验证依赖真实账号/网络。前端主发送入口现在是 `/api/agent/chat/stream`（SSE 驱动的 agent tool-loop：工具调用、审批、活页/产物、计划模式全在这条流里），不再是早期的「对话页/协作页」两页切换模型。要让前端“发送”时调用 Kimi API：

```powershell
$env:KIMI_API_KEY = "<your-kimi-api-key>"
$env:KIMI_BASE_URL = "https://api.moonshot.ai/v1"
$env:KIMI_MODEL = "kimi-k2.7-code"
npm run start:mvp
```

历史遗留接口 `POST /api/kimi/chat` 和 `POST /api/kimi/plan` 仍保留（只接受 trusted root 内的工作区，服务端经 OpenAI-compatible `POST /chat/completions` 生成文本/计划，每次调用生成 `runId`/`runPath` 写入 `.AgentCowork/runs/`），供直接调用或脚本化验收使用；当前 UI 主发送不再依赖它们。审批执行走本地 `file-ops/apply`，API key 不会暴露给前端；会话内也可通过 Composer 的模型控制面临时切换 provider/model/BYO-key，不落盘持久化。

GitHub OAuth 连接器使用 device flow；Host 从 `KCW_GITHUB_OAUTH_CLIENT_ID` 或 `GITHUB_OAUTH_CLIENT_ID` 读取 client id。前端会先调用 `/api/connectors/oauth/approve` 审批 allowlist 内的 scope，`/api/connectors/oauth/start` 需要匹配的单次 approval id，只返回 user code / verification URL / server-side session id，不把 `device_code` 下发给前端；完成授权后 access token 写入 Host 凭证仓库，Windows 默认使用 DPAPI 保护，`KCW_CREDENTIAL_STORE` 可覆盖存储路径，状态和撤销接口只返回脱敏摘要。

前端“任务卡片”直接读取 `GET /api/runs`，展示最近 run 的类型、状态、耗时和短 ID；点击卡片会读取 `GET /api/runs/<runId>`，把输入摘要、Kimi 输出或错误展开到执行动态区域。

文件 / 文件夹上传是本地导入，不会无差别上传云端：前端通过文件选择器读取用户明确选择的文件，Host 写入 trusted root 下的 `Agent_Cowork上传/<batch>/`，随后文件树和 Kimi 摘要会优先使用刚上传的文件。

上传接口：

- `POST /api/uploads/import`：导入用户选择的文件列表，单批默认最多 80 个文件、12MB，总路径必须保持在 trusted root 内。

运行记录查询接口：

- `GET /api/runs`：列出最近的 Kimi 计划运行。
- `GET /api/runs/<runId>`：读取单次运行详情，包含输入摘要、状态、耗时、结果或错误。

```powershell
$env:PORT = "3011"
$env:TRUSTED_ROOT = "C:\Users\Administrator\Desktop\agent cowork"
npm start
```

## 长期记忆（MASE 桥接，可选）

Host 支持把外部 MASE 项目（独立仓库，不随本仓库分发，需要本机自备可运行的 MASE + Python 环境）接成跨会话长期记忆后端。启动时若检测到 `MASE_MCP_ENABLED=1` 且配置了 `MASE_REPO`，会以 stdio 方式拉起 MASE 的 `integrations.mcp_server.server` 作为一条 MCP 连接器（暴露 `mcp__mase-memory__*` 工具），并在主对话流（`apps/host/src/routes/agent-stream.ts` → `apps/host/src/memory/mase-bridge.ts`）里自动接入，不需要额外前端开关：

- **读缝（每轮开始）**：拼出三段会话记忆——①本线程最近对话时间线（回答“第一句/刚才聊了啥”这类问题）；②当前结构化事实（`mase_get_facts`，无条件全量注入，不依赖措辞）；③按本轮输入做关键词召回的跨会话相关历史（与①去重，避免把“别的会话”误当“本窗口”）。召回整体有 2.5s 硬超时，超时或出错一律降级为“本轮不带记忆”，绝不让对话干等。
- **写缝（每轮成功结束）**：把用户输入、助手回答各写一条 `mase_remember` 日志；并从用户话里保守抽取显式陈述（如“我的 X 是 Y”“记住…”，跳过疑问句/任务句）upsert 成 `entity_state` 结构化事实，带 `source_log_id` 溯源，同 key 更正会自动 supersede。
- **未启用时全程 no-op**：不配置 `MASE_MCP_ENABLED`/`MASE_REPO` 时工具不会注册，两个桥接函数直接跳过，不影响现有的本地分层记忆（`loadLayeredMemory`）。

启用方式（写入本地 `.env`；`.env.example` 未内置这段，因为 MASE 是外部依赖，默认关闭）：

```
MASE_MCP_ENABLED=1
MASE_REPO=<本机 MASE 仓库绝对路径>
MASE_CONFIG_PATH=<本机 MASE 仓库绝对路径>\config.json
MASE_MEMORY_DIR=<可写的记忆数据目录>
```

确定性验收脚本（未接入 `npm run` 别名，需手动执行，且脚本内 `MASE_REPO`/路径当前写死指向本机 `E:\MASE-demo`，换机器需先改脚本里的路径常量）：

```powershell
node scripts/run-host-node.mjs scripts/smoke-mase-mcp.ts
node scripts/run-host-node.mjs scripts/smoke-mase-memory-bridge.ts
```

`smoke-mase-mcp.ts` 只验证 MCP 连接和 `mase_remember`/`mase_recall` 直连；`smoke-mase-memory-bridge.ts` 走真实 `connectMcpServers → maseRememberTurn → maseRecallSessionMemory` 桥接路径。单测见 `apps/host/test/mase-bridge.test.ts`。

## MVP-1 骨架验证

```powershell
go test ./...
```

分别从这些目录运行：

- `apps/local-agent`
- `services/api`
- `services/relay`
- `services/orchestrator`
- `services/kimi-gateway`

Kimi Gateway 已实现 OpenAI-compatible 非流式 chat client，默认走 `POST /chat/completions`，支持 bearer token、请求校验、超时、429/5xx 有界重试和响应解析。真实联网调用应由部署环境传入 Kimi/Moonshot-compatible `baseURL` 和 API key；仓库测试使用 `httptest`，不需要公网或真实密钥。

Local Agent CLI 已经可直接提供本地文件能力：

```powershell
cd "C:\Users\Administrator\Desktop\agent cowork\apps\local-agent"
go run .\cmd\agent-cowork-agent health
go run .\cmd\agent-cowork-agent list --root "C:\path\to\workspace"
go run .\cmd\agent-cowork-agent read --root "C:\path\to\workspace" --path "C:\path\to\workspace\notes.md"
go run .\cmd\agent-cowork-agent apply --root "C:\path\to\workspace" --ops "C:\path\to\ops.json" --journal "C:\path\to\workspace\.AgentCowork\audit\agent.jsonl" --batch demo
```

显式 CLI 操作 smoke：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke-local-agent.ps1
```

当前机器的 Defender ASR 也会拦截 Go 生成的临时测试 exe，规则同样是 `01443614-CD74-433A-B99E-2ECDC07BFC25`。因此该 smoke 在未放行前会报 `Access is denied`；带标签测试源码已编译通过，默认 `go test ./...` 不依赖该显式 smoke。

Windows C/WebView2 客户端骨架位于 `apps/windows-client`。MSVC 已安装在 Visual Studio Community 2026 下，但普通 PowerShell 默认不会加载 `cl.exe`。请先进入 VS Developer PowerShell 环境再构建：

```powershell
& 'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\Launch-VsDevShell.ps1' -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
cmake -S apps/windows-client -B build/windows-client-vs -G Ninja
cmake --build build/windows-client-vs --config Debug
```

本机已验证该路径可生成 `build/windows-client-vs/AgentCowork.exe`。
如果当前机器的 Microsoft Defender ASR 规则 `01443614-CD74-433A-B99E-2ECDC07BFC25` 拦截本地新构建 exe，GUI 烟测会在启动阶段报“拒绝访问”。这属于系统策略阻止执行，不是 CMake 构建失败或应用崩溃；需要用户在 Defender 中显式放行该精确 exe 路径后才能完成窗口级自动化 smoke。
`scripts\smoke-windows-client.ps1` 会在启动被拦截时读取最近的 Defender ASR 事件，并输出被拦截路径、规则 ID 和重跑命令，便于精确放行后复测。`npm run verify:windows-readiness` 是只读诊断入口；它会同时列出普通 `ExclusionPath`、ASR-only exclusion、是否缺少精确 ASR-only exe exclusion、建议授权文字和放行后复测命令。当前机器已经有项目目录级 `ExclusionPath`，但 ASR 事件仍然命中 `AgentCowork.exe`，因此 readiness 检查以 `AttackSurfaceReductionOnlyExclusions` 的精确 exe 路径作为窗口级 smoke 的放行证据。

当前完整目标的最后一步需要原生窗口级 smoke。只有在你明确接受这个安全权衡后，才应添加精确路径排除项：

```powershell
Add-MpPreference -AttackSurfaceReductionOnlyExclusions "C:\Users\Administrator\Desktop\agent cowork\build\windows-client-vs\AgentCowork.exe"
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke-windows-client.ps1
node .\scripts\run-host-node.mjs .\scripts\verify-mvp.ts --windows-client
npm run audit:mvp -- --strict
```

推荐的明确授权文字是：

```text
同意为 C:\Users\Administrator\Desktop\agent cowork\build\windows-client-vs\AgentCowork.exe 添加 Microsoft Defender ASR-only 精确路径排除项
```

### Windows 客户端操作烟测

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke-windows-client.ps1
```

该脚本会创建一个本地测试工作区，构建并启动 `AgentCowork.exe --workspace <path>`，然后验证：

- 自动加载信任工作区并扫描本地文件。
- 生成计划按钮会更新产物区，并读取信任工作区内 TXT / Markdown / CSV 的本地内容摘要。
- 生成计划会展示一个最小安全文件移动 preview。
- 审批执行按钮会写入 `.AgentCowork/artifacts/*.md`、`.AgentCowork/audit/audit.jsonl` 和 `.AgentCowork/rollback/*.jsonl`，并把预览文件移动到 `Agent_Cowork整理/<模板名>/`。
- Developer Mode 按钮会打开模型/能力边界面板。
