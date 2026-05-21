# Kimi Cowork 优化路线: 逼近 Claude Cowork 体验

> 日期: 2026-05-20
> 上游: `docs/kimi-vs-claude-cowork-gap.md`
> 原则: 按"用户感知 / 工程体力"比降序; 每个阶段都先出"能演示给非技术用户"的产物, 不追求一次到位。
> 决策前提: 沿用 `docs/open-cowork-reference-improvements.md` 的方向 — 桌面 stack 从 C/Win32 + WebView2 迁到 Tauri/Electron + React + Tailwind; Kimi 仍是默认大脑, Developer Mode 允许多模型。

---

## 阶段 0 — UX 原语三件套 (1 周, 体验跃迁最大)

这一段不动后端架构, 只补 Claude Cowork 让人"觉得像 Agent"的三个交互原语。完成后产品观感会立刻拉近一大截。

### 0.1 澄清气泡 (对位 `AskUserQuestion`)

- 后端: 在 `apps/host/src/kimi/cli-runner.js` 包一层 prompt 模板, 强制 Kimi CLI 当输入不明确时, 输出固定 JSON:
  ```json
  { "type": "clarify", "question": "...", "options": [{"label":"...","desc":"..."}], "multi": false }
  ```
- Host 检测到这个 JSON 不进 plan 流程, 直接把 `runId` 标为 `waiting_user`, runs/*.json 多一个 `clarifications` 数组。
- 前端 (React 后): 渲染为可点击的选项卡片, 选完调 `POST /api/runs/:id/answer` 续跑。
- 阶段产物: 用户问"整理这个文件夹", Kimi 反问"按客户分还是按日期分?", 用户选完才生成 plan。
- 估时: 后端 1 天, 前端 1 天。

### 0.2 任务卡片 UI (对位 `TaskCreate/Update/List`)

- `.KimiCowork/runs/*.json` 已经有数据, 缺一个常驻面板把它渲染成有状态的任务列表。
- 新增 `GET /api/tasks` 返回最近 50 条 runs + 状态 (`pending` / `planning` / `awaiting_approval` / `applying` / `done` / `failed`) + activeForm 文案 (例: "正在生成报销表草稿…")。
- 前端左侧或顶部 dock 一个固定面板; in_progress 项有 spinner 和倒计时。
- 阶段产物: 多任务并行时一眼看到每个任务在哪一步, 跟 Claude Cowork 视觉同档。
- 估时: 后端 0.5 天, 前端 1.5 天。

### 0.3 进度行 + Sources 引用

- 在 Kimi CLI 之外, Host 主动往 SSE / WebSocket 推 1 行文字进度: "正在读取 12 个 docx", "已生成预览, 等待审批"。
- 复用 `runs/*.json.events[]`, 前端订阅追加。
- 模板产物的最后一段强制带 `## 来源` 章节, 列引用到的本地文件相对路径 + 行号 / 段落。
- 阶段产物: 用户每一步都看得见, 产物可追溯到原文件。
- 估时: 1 天。

---

## 阶段 1 — 8 模板真实落地 + Office 文件抽取 (2-3 周, 拿掉"PoC 感")

这是当前最大的功能黑洞 (`docs/v0.3-implementation-status.md` 里 PDF/DOCX/XLSX 抽取明确 Not Implemented Yet)。

### 1.1 Local Agent 增加 Python 子进程桥

- Go Local Agent 当前只跑文件 op; 新增 `tool exec` 子命令: 接受 `{ tool, input }` JSON, 调一个 sidecar Python (venv 在 `~/.kimi-cowork/py/`) 执行, 全程 stdin/stdout JSON, 不暴露 shell。
- 注册四类 tool:
  - `docx.read` / `docx.write` (python-docx)
  - `xlsx.read` / `xlsx.write` (openpyxl + pandas)
  - `pptx.read` / `pptx.write` (python-pptx)
  - `pdf.read` / `pdf.extract_tables` (pypdf + pdfplumber)
- 所有 tool 路径强制走 `path-policy` 校验, 输入/输出都必须在 trusted root 内。
- 估时: 3 天。

### 1.2 Skill / Recipe 注册表

- `recipes/*.json` 描述: `name`, `triggers[]`, `inputs[]` (FileSelector / TextArea / Choice), `steps[]` (tool calls + Kimi prompt), `outputs[]`, `risk_level`。
- 跟 `docs/open-cowork-reference-improvements.md` 提到的"下一批建议 2-3"对齐。
- Host 加 `GET /api/recipes`, `POST /api/recipes/:id/run`, 前端"模板"页直接列。
- 估时: 2 天。

### 1.3 首批 3 个真实可演示的模板 (而不是 8 个空壳)

按白领高频度先做 3 个, 比 8 个 TODO 状态有用得多:

1. **会议纪要 → 行动项 xlsx**: 输入若干 .docx/.md, 用 `docx.read` + Kimi 抽取, `xlsx.write` 生成 `action_items.xlsx`, audit + rollback。
2. **Excel 清洗**: 输入一张 .xlsx, `xlsx.read` → pandas 检测重复/缺失/日期格式 → Kimi 给修复 plan → preview diff → `xlsx.write` 输出 cleaned 版 + `data_issues.md`。
3. **报销整理**: 输入 PDF/截图发票批, `pdf.read` (有 OCR 走 tesseract) → Kimi 抽金额/日期/类别 → `reimbursement.csv`。

每个模板必带: 预览页 + 审批 + 回滚 + audit。完成 1 个就立刻能演示给真实白领用户。

估时: 每个模板 3 天 (含联调), 总 9 天。

### 1.4 文件卡片渲染 (对位 `present_files`)

- 产物列表 / artifacts 不再是文本链接, 渲染成卡片: 文件图标 + 文件名 + 大小 + 操作按钮 ("在系统中打开" / "复制路径" / "再生成")。
- 前端用一个简单的 `file://` shell open (Electron `shell.openPath` / Tauri `shell.open`)。
- 估时: 0.5 天。

---

## 阶段 2 — Artifact + Memory + Schedule (2-3 周, 让产品"活下去")

Claude Cowork 的隐形护城河是: 产物不只是文件, 还是可以重新打开、自动刷新、记住偏好的"活页"。

### 2.1 SQLite 化跨会话状态

- v0.3 plan 已把 SQLite 列为方向, 但 status 文档明确没做。
- 加 `apps/host/src/storage/sqlite.js` (better-sqlite3, 同步 API, 没有原生依赖痛苦), schema:
  - `runs` (取代部分 runs/*.json 的索引)
  - `recipes_history`
  - `trusted_roots` + `permissions`
  - `memory_facts` (key, value, scope, updated_at) — 对位 Claude Cowork 的 memory-management
  - `schedules`
- runs/*.json 仍然保留为审计证据, SQLite 只做索引和热数据。
- 估时: 3 天。

### 2.2 持久 HTML Artifact (对位 `create_artifact`)

- 每次模板跑完, 除了写 .xlsx, 同时生成 `.KimiCowork/artifacts/<runId>.html` — 自包含 HTML, 引一个 `kimi-artifact.js`。
- 这个 JS 提供两个原语:
  - `window.kimi.callTool(name, args)` → 走 localhost host API 调注册的 tool;
  - `window.kimi.askKimi(prompt, data)` → 走 `/api/kimi/chat`, 用 Kimi 默认模型做内嵌摘要 / 分类。
- 比如"客户反馈分类"产物是一个真的可筛选/可下钻的 HTML 表, 用户每次打开都自动从 trusted root 重新拉最新反馈源。
- localStorage 记住筛选/排序偏好。
- 用 `<webview>` (Tauri) / `BrowserWindow` (Electron) 打开, 不走系统浏览器以保住 localhost API 同源。
- 估时: 5 天 (含 1 个示例 artifact)。

### 2.3 Scheduled Tasks (对位 `scheduled-tasks`)

- 加 `apps/host/src/runtime/scheduler.js`: 进程内 node-cron + 一次性 setTimeout (重启自动从 SQLite 重建)。
- 每次模板跑完, Host 主动建议: "要不要每周一早上 9 点自动跑一次?", 一键创建。
- 触发时调用对应 recipe, 结果落到 runs + 推一条系统通知。
- 估时: 3 天。

### 2.4 Memory 系统 (对位 `memory-management`)

- 项目级 `CLAUDE.md` 等价物: `<trusted_root>/.KimiCowork/MEMORY.md` + `memory/*.md`。
- Host 在每次 Kimi CLI 调用前注入 MEMORY.md 前 4KB 作为 system 段。
- 加 `consolidate-memory` 等价命令: 合并重复事实、prune 过期项。
- 用户可以让 Kimi"记住"客户简称、项目代号、表格命名规则; 下次对话直接懂。
- 估时: 3 天。

---

## 阶段 3 — Stack 迁移 + MCP 客户端 (1-2 月, 打地基)

这是最大的一段体力, 但越拖越贵。建议在阶段 2 中后段并行启动。

### 3.1 桌面 stack: 选 Tauri 还是 Electron

| 维度 | Tauri | Electron |
|---|---|---|
| 安装包 | ~10MB | ~150MB |
| 内存 | 低 | 高 |
| Rust 学习曲线 | 有 | 无 |
| WebView 一致性 | 跟 OS 走 (Win 用 WebView2) | 固定 Chromium |
| 现有 C 客户端复用 | 不行, 全弃 | 不行, 全弃 |

**建议 Tauri**: 安装包对白领用户极友好, Windows 上仍走 WebView2 (跟当前方向一致), Rust 侧可以直接 wrap 现有 Go Local Agent 二进制。Defender ASR 的 exe 拦截问题 Tauri 也比手编 C 更容易被 OEM 信任。

迁移步骤:
1. 把 React + Tailwind 的前端 (从静态 HTML 重写) 接到 Tauri command;
2. Tauri Rust 侧只负责 IPC + 启动 Local Agent + 系统通知 + shell.open;
3. Host (Node) 仍跑 localhost API, 不变;
4. 旧 C 客户端归档到 `apps/windows-client-legacy`, ASR 战线先撤。

估时: 3 周。

### 3.2 MCP 客户端 + 4 个 starter 连接器

- 在 Host 里集成 `@modelcontextprotocol/sdk` 的 client 端;
- 先内置 4 个本地化白领高频连接器, 都走"先用浏览器登录 → 本地存 token → 调 API"流程:
  1. **企业微信 / 飞书 / 钉钉** 二选一 (本地文档/审批集成)
  2. **Outlook / Gmail** (邮件草稿落到本地)
  3. **Notion / 语雀 / Confluence** (知识库读写)
  4. **本地 Office 自动化** (用 COM / WinRT 包成 MCP server, 复用 Windows-MCP 思路)
- 每个 MCP tool 都进 audit, 默认审批; 网络调用 + 写动作必须二次审批。
- 估时: 每个连接器 3-5 天。

### 3.3 工具懒加载 (对位 `ToolSearch`)

- 当 MCP 工具超过 30 个时, 不要全量塞到 Kimi CLI 的 system prompt。
- Host 内置一个工具索引 (name + description + 关键词), 第一次让 Kimi 输出"我需要工具 X / 关键词 Y", 第二次再注入具体 schema。
- 这是为后期生态扩张省 context 必须做的。
- 估时: 4 天。

---

## 阶段 4 — 拉开差异化的长尾 (持续)

按收益排序:

1. **浏览器 Agent** (对位 Claude in Chrome): 你们已经有 `smoke:rendered-ui` 用 Edge/Chrome DevTools 协议的成熟代码, 把它产品化成"打开浏览器帮我填表 / 截图 / 抓页面"工具, 是低成本护城河。
2. **角色化插件包** (对位 customer-support / HR / engineering plugin): 把 8 模板按"行政助理 / HR / 财务 / 法务 / 销售助理"5 个中文白领角色重新分包, 安装时让用户选自己的岗位。配合 onboarding 流程。
3. **askKimi inline + 多档模型**: Artifact 里调便宜模型做实时摘要/分类。kimi-gateway 当前只有非流式 chat, 补 streaming + tool calls + vision。
4. **Skill / MCP creator UI**: 让高级用户用自然语言造 recipe 和 MCP server, 对位 skill-creator / mcp-builder。
5. **桌面 OS 自动化 MCP**: 把现在 Windows C 客户端的 UI 自动化能力拆成 MCP server (App / Click / Type / Screenshot / Clipboard / PowerShell), 跟 Claude Cowork 的 Windows-MCP 同档。

---

## 阶段-能力 对照速查

| 你想"接近"哪个 Claude 体验 | 去做哪一阶段 |
|---|---|
| 让 Kimi 会问问题 | 0.1 澄清气泡 |
| 多任务并行可视化 | 0.2 任务卡片 |
| 每一步看得见 + 引用 | 0.3 进度行 + Sources |
| 真能出 docx/xlsx/pptx/pdf | 1.1 + 1.3 |
| 模板像 Skill 一样可扩展 | 1.2 Recipe 注册表 |
| 产物可重新打开、自动刷新 | 2.2 持久 Artifact |
| Kimi 记得我的命名习惯 | 2.4 Memory |
| 每周一自动跑 | 2.3 Scheduled |
| 装包小、不被 ASR 拦 | 3.1 Tauri 迁移 |
| 接外部 SaaS | 3.2 MCP + 连接器 |
| 工具多了不爆 context | 3.3 ToolSearch |
| 浏览器自动化 | 4.1 |
| 行政/HR/财务一键就绪 | 4.2 角色化插件包 |

---

## 30 天最小路径 (如果只能做一条线)

如果你只能选一条 30 天能闭环的路径来最大化"像 Claude Cowork 的程度", 推荐:

```
Week 1: 0.1 澄清气泡 + 0.2 任务卡片 + 0.3 进度行
Week 2: 1.1 Python 子进程桥 + 1.2 Recipe 注册表
Week 3: 1.3 真实落地 2 个模板 (会议纪要 + Excel 清洗)
Week 4: 2.1 SQLite + 2.4 MEMORY.md + 2.3 一个最小 cron 演示
```

跳过 阶段 0.2 之外的 UI 大改 (Tauri 迁移挪到第二个 30 天), 跳过 MCP (放到第二个 30 天)。这 4 周末尾你拿到的产物是: 一个会反问、有任务卡片、能跑出真实 xlsx、记得你的偏好、可以定时跑的 Kimi Cowork — 已经能给真实白领用户演示, 而不是只能给开发者跑 smoke。

---

## 不应该做的 (反向建议)

- **不要继续投入 C/Win32 + WebView2 + Defender ASR 放行链路**: ROI 已经验证为负。`verify:windows-readiness` 这套验收编排留下, exe 弃用。
- **不要追平 Claude Cowork 的 60+ Skill 数量**: 用户感知的是"有 3 个真好用"而不是"有 60 个"。先做精 3 个,然后让 Recipe 注册表降低边际成本, 不要急着 list 多。
- **不要急着开放 Developer Mode 多模型 UI**: 在 Kimi 主线还有大量 TODO 时, 多模型路径只会稀释精力。Kimi Gateway 当前的 OpenAI-compatible 已经是兜底。
- **不要在阶段 0 之前去做云端 services/***: services/api / relay / orchestrator 现在的骨架够你跑 unit test 占位即可, 把云端做扎实是 V1.5/V2 的事。

---

## 2026-05-20 本轮实现状态

已落地到当前仓库:

- **Chat UX Redesign MVP**: 新增主对话 `conversation-timeline`, 普通 Chat 与 Cowork handoff 都会生成用户/assistant 气泡; assistant 气泡内嵌进度、预览、审批、来源和产物卡。
- **Stage 0.1 Clarification**: 前端新增 `clarify-panel`, 宽泛指令会先让用户选择执行方向。
- **Stage 0.2 Task Card**: 既有 `/api/runs` 任务卡片继续保留, 本轮新增 `/api/tasks` 任务视图别名。
- **Stage 0.3 Sources**: 模板执行流新增 `Sources` 步骤, 前端产物摘要显示来源文件和摘录。
- **Stage 1.1 文档抽取**: 新增 `/api/files/extract`, 支持 TXT/MD/CSV/JSON/LOG、DOCX、XLSX、PPTX、基础 PDF 文本抽取。
- **Stage 1.2 Recipe Registry**: 新增 `/api/recipes` 和 `/api/recipes/:id/run`, 内置 8 个 Kimi-only 本地模板。
- **Stage 1.3 首批真实模板**: `meeting-actions` 生成 Markdown + XLSX, `excel-cleaning` 生成清洗报告 + XLSX, `reimbursement` 生成 CSV + Markdown。
- **Stage 1.4 文件搜索/产物卡**: 新增 `/api/files/search`, 文件写入支持 base64 二进制产物, 审批流可写入 XLSX。
- **Scale-ready 地基**: Host API 生成 `trace_id`、`tenant_id`、`user_id` 响应头, `/api/file-ops/apply` 支持 `Idempotency-Key` 幂等重放。

仍保留为后续阶段:

- 真正的 SSE/WebSocket event stream、runs event replay、Composer `/`/`@`/`#` popover 和右侧 drawer 化还未完成。
- SQLite 持久化、Memory、Scheduled Tasks、HTML Artifact 的完整可编辑视图。
- Tauri/Electron 迁移、MCP 客户端、插件市场和浏览器 Agent。
- Office/PDF 高保真解析仍是 MVP 级抽取, 不含 OCR、复杂表格恢复、PDF 表单填充。

本轮新增验收:

- `npm run smoke:ui` 通过, 静态契约已覆盖 `conversation-timeline`、message bubble controller 和 Composer send router。
- `npm run smoke:rendered-ui` 通过, 覆盖真实 Edge 渲染、compact 布局、发送计划、审批执行和上传文件 handoff。
