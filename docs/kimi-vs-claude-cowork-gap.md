# Agent Cowork vs Claude Cowork 差距分析

> 日期: 2026-05-20
> 对比基准:
> - Agent Cowork: `plan/agent-cowork-latest-product-plan-v0.3.md`, `docs/v0.3-implementation-status.md`, 当前仓库代码 (apps/host, apps/local-agent, apps/windows-client, services/*).
> - Claude Cowork: 当前正在运行的 Cowork 桌面应用,基于 Claude Code + Claude Agent SDK,通过实际可见的工具/Skills/MCP/Artifacts/定时任务能力盘点。

## 0. 一句话定位差异

Agent Cowork 当前是"Windows 本地文件可信操作 + 审批回滚 + Kimi CLI 计划"的 PoC 主机; Claude Cowork 是一个"以 Agent + Skills + MCP 生态 + 持久 Artifacts + 定时任务 + 多角色插件"为骨架的通用桌面 Agent 工作台。两者在"本地文件审批/回滚/审计"这一点上方向一致,但 Claude Cowork 在生态、可扩展性、UI 交互原语、Agent 编排上领先一个量级。

---

## 1. 用户体验与交互 (UX)

| 能力 | Agent Cowork 现状 | Claude Cowork 现状 | Kimi 差距 |
|---|---|---|---|
| 主交互形态 | 单一聊天 + 协作工作台 + 文件树; 主输入触发 plan/preview/approve handoff | 自由对话 + 自动 handoff 到 Skills/Plugins; 多种内联可视化 | 缺多模态原语 |
| 澄清问题 | 无 (直接接受 prompt) | `AskUserQuestion` 多选题 (最多 4 题/4 选项, 自动带 Other, 支持 multiSelect + preview 卡片) | **缺结构化澄清** |
| 任务追踪 | 仅 `.AgentCowork/runs/*.json` 后台落盘 + 协作页 runId | `TaskCreate/Update/List` 渲染成可视化任务卡片, in_progress 时显示 activeForm spinner | **缺前台任务卡片 UI** |
| 文件分享 | preview + apply 后写入 artifacts/, UI 列出 | `present_files` 渲染可点击文件卡片, `.skill` 文件还附带"Save skill"安装按钮; `computer://` 链接直接打开 | **缺统一文件呈现原语** |
| 内联可视化 | 无 (前端只有静态 HTML + 文本气泡) | `show_widget` 内联渲染 SVG / HTML / Chart.js / Mermaid / Grid.js, 自动暗色适配, 通过 `read_me` 模块化拉取规范 | **缺可视化原语** (图表/流程图/dashboard 都需要自己实现) |
| 持久视图 | 无 | `create_artifact` 保存自包含 HTML 页, 跨会话存在, 每次打开自动从 connector 拉新数据 (`window.cowork.callMcpTool/askClaude/runScheduledTask`) | **缺 Artifacts 概念** |
| 引导/Onboarding | README 命令行说明 | `setup-cowork` Skill + `show_onboarding_role_picker` (角色选择→匹配 plugin → 连工具 → 试跑 skill) | **缺新手引导** |
| 角色化定制 | 单一 Office Mode + Developer Mode | 角色 plugin (engineering/data/design/customer-support/HR/productivity) 各自带 7-10 个 skill, 通过 marketplace 安装 | **缺角色化的 plugin 集** |
| 文件夹授权 | TRUSTED_ROOT 环境变量 + UI 选择器 | `request_cowork_directory` 工具触发系统级目录授权对话框, 默认有 mount, 路径在 system prompt 中明示 | 体验类似, Kimi 已有 |
| 进度/中间反馈 | 协作页显示 plan/preview/audit 状态 | system prompt 强制 "短而频繁的进度更新", 单句更新触发到对话流 | 形式上 Kimi 已有, 但缺细颗粒度提示 |
| 计算机链接 | 无 (前端用文件树) | `computer://` 协议链接直接从聊天打开本地文件 | **缺一键打开本地文件** |
| 引用/Citation | 无 | system prompt 强制工具结果带 `Sources:` 章节, 自动 `[Title](URL)` | **缺统一引用规范** |

**判断**: UX 层是 Agent Cowork 当前差距最大的地方。Claude Cowork 的核心体验是一整套 "Agent 原语" (问、答、选、卡片、Widget、Artifact、Task Card、Source、computer://),Agent Cowork 目前只有"聊天 + 文件树 + preview 弹窗"三件。

---

## 2. 核心功能与工具

### 2.1 文件 / 工作区类

| 能力 | Agent Cowork | Claude Cowork | 差距 |
|---|---|---|---|
| 读文件 | Host API + Go local-agent CLI | `Read` 工具 (绝对路径, 支持 PDF 分页, ipynb, 图片) | Kimi 仅支持文本 + 摘要, **缺 PDF/图片/notebook 原生读** |
| 写/编辑文件 | preview → apply (write/rename/move, 禁止 delete) | `Write` (覆盖确认) + `Edit` (精确替换, 必须先 Read) | Kimi 在 **审批回滚** 维度反而更强, 但在 **细粒度 Edit/replace_all** 上没有 |
| 文件搜索 | 文件树枚举 + 简单筛选 | `Glob` (按 mtime 排序) + `Grep` (ripgrep, multiline, type filter) | **缺 ripgrep 级 grep** |
| 路径策略 | path-policy.go 阻挡 sensitive / escape | system prompt 区分 outputs / mount / uploads / skills, sandbox 路径白名单 | 类似, Kimi 已实现 |
| 批量重命名/移动 | preview 已实现 single op, multi-file 仍 TODO (status 文档) | 没有专门 batch 工具, 但 `Edit replace_all` + Bash 可拼装 | Kimi 在 "审批可视化 batch" 上反而有优势空间 |
| Office 文件抽取 (DOCX/XLSX/PPTX/PDF) | 仅 TXT/MD/CSV 摘要 (status 文档明确未实现 PDF/DOCX/XLSX) | 通过 `docx` / `xlsx` / `pptx` / `pdf` Skills 调 python-docx / openpyxl / python-pptx / pypdf, 完整读写 | **核心办公场景缺一大块** |
| 文件操作日志 | JSONL audit + rollback journal | 默认不强制审计, 由 Skill 决定 | Kimi 在 **审计/回滚** 上更强 |

### 2.2 模型 / Agent

| 能力 | Agent Cowork | Claude Cowork | 差距 |
|---|---|---|---|
| 主模型 | Kimi (CLI `--print --final-message-only` + Kimi Gateway OpenAI-compatible) | Claude Opus 4.6 / Sonnet 4.6 / Haiku 4.5 多档可选 | 模型层 Kimi 自己决定, **缺多档调度** |
| 廉价二线推理 | 无 | Artifact 内 `window.cowork.askClaude(prompt, data)` 调 Haiku 做实时摘要/分类 | **缺 inline 廉价推理原语** |
| 子 Agent | 无 (Kimi CLI 单 shot) | `Agent` 工具支持 subagent_type: Plan / Explore / general-purpose / claude-code-guide / 自定义, 可用 worktree isolation | **缺子 Agent 编排** |
| Plan Mode | 协作工作台 = preview-only plan | `Plan` agent + `ExitPlanMode`, 强制先方案后执行 | 形式上 Kimi 已有, 缺产品化的 plan UI |
| Trace 调试 | runs/*.json 落盘 | 默认不暴露, 但 Skills 里 doc-coauthoring 等可结构化输出 | Kimi 反而更透明 |

### 2.3 工具/连接器生态

| 能力 | Agent Cowork | Claude Cowork | 差距 |
|---|---|---|---|
| MCP 客户端 | 规划中 (Developer Mode V1) | 完整 MCP host, 系统 prompt 列出连接中/已连接 server | **完全缺 MCP 实现** (v0.3 仅规划) |
| 内置连接器 | 无 | Notion / Slack / Gmail / Google Calendar / Asana / Linear / Jira / ClickUp / Monday / GitHub / Figma / Datadog / PagerDuty / Intercom / Hubspot / Guru / Amplitude / BigQuery / Hex / Definite / Webflow / MS365 / Microsoft Docs / Context7 等 (角色 plugin 自带 OAuth) | **没有外部 SaaS 连接器** |
| 浏览器自动化 | 无 | `Claude in Chrome` MCP: navigate/get_page_text/javascript_tool/form_input/file_upload/screenshot/gif_creator 全套 | **没有浏览器 Agent** |
| 本地 OS 自动化 | 无 | `Windows-MCP`: App/Click/Type/Scrape/Screenshot/PowerShell/Registry/Process/Clipboard/Shortcut | Windows 客户端骨架已搭, 但**没有对外暴露的 OS 自动化原语** |
| PDF 表单 | 无 | `PDF Tools` MCP: fill/sign/merge/split/extract/bulk_fill_from_csv/signature zones 完整套件 | **PDF 处理只能靠 Kimi 读, 不能 fill/sign** |
| Web 搜索/抓取 | 无 | `WebSearch` + `mcp__workspace__web_fetch` (带 robots/合规策略, JS-rendered 自动 fallback 到 Chrome) | **没有自带搜索/抓取** |
| 工具动态发现 | 无 | `ToolSearch` 延迟加载 (避免上下文爆炸); `mcp-registry` 动态搜索 + suggest_connectors | **缺工具懒加载机制** (当前 host 把所有 API 全暴露) |
| Plugin marketplace | 无 | `plugins:list/search/suggest_plugin_install` + 角色化 plugin 安装 | **缺插件市场** |

### 2.4 Skills (声明式能力)

| 类别 | Agent Cowork | Claude Cowork | 差距 |
|---|---|---|---|
| 概念 | 8 个 MVP "任务模板" 规划中 (整理文件/会议纪要/合同摘要/报销/反馈/总结/Excel 清洗/邮件), 均 `[MVP] [ ]` 未实现 | Skills = markdown + scripts 包, 按需 Read, 已预装 60+ 个 (跨办公/工程/数据/设计/HR/客服等) | **8 vs 60+, 而且 8 个全是 TODO** |
| 文档生成 | TODO | docx/xlsx/pptx/pdf 全套 (调真实 python 库) + theme-factory 主题 + brand-guidelines | **缺真实办公产物生成** |
| 创意/设计 | 无 | canvas-design / algorithmic-art / slack-gif-creator / web-artifacts-builder | **缺创意类 skill** |
| 协作文档 | 无 | doc-coauthoring / internal-comms 全流程 | **缺协作产物流程** |
| Meta Skill | 无 | skill-creator (建/改/eval skill); mcp-builder (建 MCP server); consolidate-memory | **缺 "造工具" 的工具** |
| 自动触发 | 无, 全靠路由 | Skill 描述里 "MANDATORY TRIGGERS"; LLM 看到匹配触发 | **缺触发匹配机制** |

### 2.5 任务编排与持久化

| 能力 | Agent Cowork | Claude Cowork | 差距 |
|---|---|---|---|
| 任务列表 | `.AgentCowork/runs/` 文件 | TaskCreate/Update/List/Get/Stop (有 blocks/blockedBy 依赖) + 渲染 widget | **缺任务依赖图 + 前台呈现** |
| 定时任务 | 无 | `scheduled-tasks:create/list/update` 支持 cron + 一次性 fireAt, 主动建议 ("Want me to run this each morning?") | **完全缺定时任务** |
| 持久 Artifact | apply 后的 markdown/csv 落盘到 artifacts/ | `create_artifact` 持久 HTML 页, 跨会话可再开, 自动拉新数据 + 支持 localStorage 记住用户偏好 + 支持 askClaude 内联 LLM 调用 | **缺"活的" Artifact** (Kimi 的是死文件) |
| 记忆系统 | 无 | productivity:memory-management (CLAUDE.md + memory/) + consolidate-memory 定期合并; system prompt 里读 working memory | **缺跨会话记忆** |
| 任务历史复跑 | runs/*.json 已存, 但 UI 没"复跑" | scheduled task + artifact reload + memory 三件套 | Kimi 数据已落盘, **差 UI 和复跑能力** |

---

## 3. 底层架构与能力

| 维度 | Agent Cowork | Claude Cowork | 差距 |
|---|---|---|---|
| 客户端形态 | Windows C/Win32 + WebView2 骨架, MSVC 编译, 被 Defender ASR 拦截待放行; 同时有 Node host 跑 web UI | 桌面客户端 (Electron 系) + 沙箱 VM, 直接挂载用户选择目录 | Kimi 选了更难的路 (原生 C/Win32). **WebView2 嵌入仍未完成, 安装器没做, ASR 仍卡** |
| 桌面 stack 选型 | C/Win32 + Node host, 反思后倾向 Electron/Tauri + React/Tailwind (`open-cowork-reference-improvements.md`) | Electron (推测) + Anthropic Claude SDK + Claude Code + MCP host | **stack 还未迁移** |
| 沙箱执行 | command-runner 默认关闭; 计划用 Docker/Hyper-V/WSL2 | 内置 Ubuntu 22 Linux sandbox (Python/Node 预装, 网络白名单), 每次 bash 独立无 cwd 继承 | **Kimi 几乎没有 sandbox 计算能力**, 只能跑 Node + Kimi CLI |
| 文件路径映射 | trusted root 单一 | mount → bash path 自动映射 (outputs/uploads/mount/skills), 在 system prompt 明示 | Kimi 路径策略简单, **缺路径分层 + 自动映射** |
| 持久化 | JSON 文件 (.AgentCowork/runs, audit, rollback, artifacts) | SQLite + 文件 (推测), Artifact 系统 + 定时任务 + memory 全跨会话 | **缺 SQLite + 跨会话状态** (status 文档明确未实现) |
| 安全模型 | trusted root + preview + approval + JSONL audit + rollback journal, 禁止 delete | system prompt 规则 (web 内容限制, 不绕过, escalate to chrome 工具); 工具级别审批由 client UI 处理 | Kimi 在 **强制审批/回滚** 这点上设计更扎实 |
| 多用户/云端 | services/api + relay + orchestrator + kimi-gateway 全是骨架, 单元测试通过, 业务全 TODO | Anthropic 后端多租户 + OAuth + plan limits | **云端能力全骨架, 离可用差很远** |
| Device Relay | WebSocket 未实现 | 不需要 (单设备客户端 + 云 API) | 差距大但路径不同 |
| 模型网关 | kimi-gateway 实现 OpenAI-compatible 非流式 chat + 重试/超时, httptest 覆盖 | 直连 Anthropic Messages API | Kimi 网关方向对, 但**缺流式、function calling、vision、tool calling** |
| 工具协议 | 计划用 MCP (Developer Mode V1) | MCP 已全量落地, 工具 schema 走 `ToolSearch` 延迟加载 | **MCP 客户端 + 服务发现 + 懒加载** 都缺 |
| 引用/Source 处理 | 无 | Citation requirement 内置在 system prompt; tools 返回 url + title 自动渲染链接 | **缺统一引用层** |
| 工具上下文管理 | 全部工具在 system prompt 暴露 | ToolSearch 延迟 + read_me 模块化 + skills 按需 Read, 控制 context 膨胀 | **缺工具/上下文 budget 管理** |
| 代码沙箱 + UI 调试 | smoke:rendered-ui 用 Edge/Chrome DevTools 协议跑 headless 验收 (这点很扎实) | 没有这个等价物, 由 Anthropic 自己测 | **Kimi 这一项是亮点, 不是差距** |

---

## 4. Agent Cowork 当前的优势 (不全是差距)

- **审批 + 回滚 + 审计三件套设计扎实**: preview / apply / rollback journal / JSONL audit / no-overwrite / no-delete, 这套面向白领办公的安全语义比 Claude Cowork 默认更严。
- **本地优先 + 信任目录边界明确**: trusted root + path-policy 比 Claude Cowork 的 mount 模型更"白领可解释"。
- **rendered UI smoke + Windows readiness 诊断闭环**: `smoke:rendered-ui` / `verify:windows-readiness` / `audit:mvp` 这一整套验收编排是 Kimi 团队的工程长板, Claude Cowork 没有同等可见物。
- **Kimi CLI 运行记录 `.AgentCowork/runs/*`**: 输入摘要、耗时、错误结构化落盘, 比 Claude Cowork 自带的可观察性更接近"审计级"。
- **中文白领场景的产品定位**: v0.3 plan 的 8 个模板 (报销/会议纪要/合同/反馈/邮件) 比 Claude Cowork 默认 plugin 集 (偏 SaaS / 工程) 更贴中国白领日常。

---

## 5. 按优先级补齐建议 (P0 → P2)

### P0 (1-2 周内, 拿掉"只是 PoC"的感觉)

1. **8 个 MVP 模板真实落地**: status 文档里 8 个 `[MVP] [ ]` 全 TODO; 至少先做"会议纪要→行动项"和"Excel 清洗"两个真能出 xlsx 的; 调 python-docx/openpyxl 通过 Local Agent shell。
2. **DOCX/XLSX/PPTX/PDF 抽取**: 这是阻塞绝大多数白领模板的硬伤; 接 `pypdf` / `python-docx` / `openpyxl` / `python-pptx`, 由 Go Local Agent 走 sandbox 子进程调。
3. **AskUserQuestion 等价物**: 在前端加一个"澄清气泡" UI (单选/多选 + Other), 后端 Kimi CLI prompt 里加 "如果不确定就只问 1 个问题" 的 system, 把没指定的 input 显式问出来。
4. **Task Card UI**: 把 `.AgentCowork/runs/*.json` 渲染成左侧或顶部的可视化任务列表, 状态 in_progress 时显示 spinner + activeForm; 这是 Claude Cowork 体验区分度最大的来源。
5. **Electron/Tauri + React/Tailwind 迁移**: `open-cowork-reference-improvements.md` 已经记下方向, 但仍未动工; 当前 C/Win32 + WebView2 + ASR 拦截链路对终端用户安装太重, 建议先用 Tauri 跑出 v1, C 客户端留作后续高级模式。

### P1 (1-2 个月, 进入"产品" 阶段)

6. **MCP 客户端 + Skill 注册表**: 实现 MCP host (复用 OpenAI-compatible 同套 schema), 至少先内置 Slack / Notion / Gmail / 日历四个连接器; Skill manifest (名称/适用类型/权限/产物) 落到 `recipes/*.json`, 前端"自定义"页可启停。
7. **Scheduled Tasks**: cron + 一次性触发, runs 复跑入口, 接入 Kimi 计划生成; 白领最痛的就是"每周一汇总周报", 这个能直接产品化。
8. **持久 Artifact (HTML view)**: 把 apply 后的 markdown/xlsx 不仅作为文件, 还包成一个可重新打开、自动从 Kimi 拉新数据的 HTML 视图; 这是 Claude Cowork 的差异化武器之一, 对运营/HR 用户感知特别强。
9. **跨会话记忆**: SQLite 化 + CLAUDE.md/memory 等价物, 解决 v0.3 plan 4.1 模板每次都要重新交代上下文的问题。
10. **统一进度/引用 UI**: 进度行 (单句更新) + Sources 引用规范, 让运行过程对用户可读。

### P2 (3 个月+, 拉开生态)

11. **Plugin marketplace + 角色化 plugin 集**: 模仿 Claude 的 customer-support / HR / engineering / data 分包, 但做成 "行政助理 / HR / 财务 / 法务" 等中文白领角色, 8 模板按角色重新组织。
12. **浏览器 Agent (Edge/Chrome DevTools 协议)**: Kimi 已经有 rendered-ui smoke 的 DevTools 协议经验, 把它产品化成"浏览器 Agent"工具, 是相对低成本的护城河。
13. **Skill creator / MCP builder 的中文等价物**: 让高级用户和开发者能在本机用 Kimi 自己造 Skill 和 MCP, 直接对位 Claude 的 skill-creator/mcp-builder。
14. **多档模型调度**: 引入便宜的二档模型 (Kimi 长上下文 + 小模型) 给 Artifact 内的实时摘要/分类, 对应 Claude 的 `askClaude(prompt, data)` 概念; kimi-gateway 现在只有非流式 chat, 还要补 streaming + tool calls + vision。

---

## 6. 一句话总结

**Agent Cowork 当前是 Claude Cowork 的"安全核与本地审批核"半成品**: 在 trusted root / preview / apply / rollback / audit / runs / 验收编排上已经接近 Claude Cowork 的同水位甚至更严格; 但在 **Skills (60+ vs 8 TODO)**、**MCP 生态 (全套 vs 规划中)**、**Artifact + Scheduled Task + Memory 三件持久化**、**前端交互原语 (AskUser/Task Card/Widget/Source/computer://)** 这四块上差距是数量级。当前 P0 应该聚焦"把 8 个模板真实跑通 + 加 Task Card UI + 迁 Tauri/Electron", 而不是继续抠原生 C 客户端 + ASR 放行。

---

## 7. 2026-05-20 本轮补齐状态

P0 已部分落地:

- **8 个 MVP 模板入口**: `/api/recipes` 已返回 8 个 Kimi-only 模板, 前端新增任务模板面板。
- **首批真实模板**: `meeting-actions`、`excel-cleaning`、`reimbursement` 已能生成本地可审批产物, 其中前两个可输出 XLSX。
- **DOCX/XLSX/PPTX/PDF 抽取**: `/api/files/extract` 已接入基础抽取, 可供模板和聊天摘要使用。
- **AskUserQuestion 等价物**: 前端新增澄清气泡, 宽泛指令先让用户选择任务方向。
- **Task Card UI**: 已通过 `/api/runs` 和 `/api/tasks` 展示任务卡片和运行详情。
- **Sources 原语**: 执行动态和产物摘要都显示来源文件, 对齐 Claude Cowork 的引用/来源体验雏形。

仍然存在的主要差距:

- **MCP / Connector / Plugin marketplace** 仍未实现。
- **Scheduled Tasks、Memory、HTML Artifact** 仍未实现。
- **Office/PDF 能力是 MVP 抽取**, 不是 Claude Skills 那种基于专用库的高保真读写。
- **Electron/Tauri 迁移未做**, 当前仍是 Node Host + Windows WebView2 资源。
- **子 Agent、浏览器 Agent、OS 自动化 MCP** 仍属于 P2。
