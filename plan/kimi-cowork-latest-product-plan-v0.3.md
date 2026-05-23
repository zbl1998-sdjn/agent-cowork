# Agent Cowork 最新产品规划设计 v0.3

> 日期：2026-05-20  
> 定位：Kimi Desktop 与 Kimi CLI 之间的空白产品。面向白领、行政、运营、财务、HR、法务、助理等非技术用户，同时提供开发者模式，允许接入其他大模型、MCP、CLI、脚本和自定义工具。  
> 核心原则：普通用户不用命令行；本地文件可控处理；所有高风险动作先预览、再审批、可回滚；Kimi 是默认核心大脑，开发者模式支持多模型。

---

## 0. 状态标记说明

- `[ ]` 未开始
- `[~]` 进行中
- `[x]` 已完成
- `[!]` 风险项 / 需要特别确认
- `[MVP]` 第一版必须完成
- `[V1]` MVP 后第一个正式版本
- `[V2]` 企业版 / 高阶版本

---

## 1. 一句话产品定义

**Agent Cowork 是一个 Windows 本地办公 Agent 工作台：普通用户用自然语言处理本地文件、Word、Excel、PPT、PDF、会议纪要、发票、合同、邮件草稿和行政流程；开发者模式可接入 Kimi CLI、Kimi API、MCP、LiteLLM、多模型和自定义工具。**

它不是纯 Kimi Desktop，也不是纯 Kimi CLI，而是中间层：

```text
Kimi Desktop / Web
  优点：易用、聊天、文档/网页/研究能力强
  缺口：对本地文件、Windows 工作区、本地流程、审批/回滚支持不足

Agent Cowork
  目标：低门槛本地工作台 + 文件/流程/审批/交付物 + 可选开发者能力

Kimi CLI / Kimi Code
  优点：强 Agent、可读写代码、可执行命令、开发者友好
  缺口：普通白领和行政用户不会用，也不应直接接触 shell 权限
```

---

## 2. 目标用户

### 2.1 核心用户：白领 / 行政 / 办公人员

典型用户：

- 行政助理
- 总助 / 秘书
- 人事 HR
- 财务 / 报销专员
- 运营 / 客服运营
- 销售助理
- 法务助理
- 项目经理
- 咨询顾问 / 分析师

他们的共同特点：

- 大量工作发生在 Windows 本地文件夹、微信/企业微信/飞书/钉钉下载目录、Office/WPS 文档、Excel 表格、PDF、截图和邮件草稿里。
- 不会使用 CLI，也不理解 agent 权限、shell 命令、MCP、API Key。
- 更关心“能不能把事情安全做完”，而不是模型参数。

### 2.2 次级用户：开发者 / 高级用户

典型需求：

- 使用 Kimi CLI / Kimi Code 能力。
- 接入 OpenAI、Gemini、DeepSeek、Qwen、本地 Ollama/vLLM 等其他模型。
- 配置 MCP、本地工具、脚本、插件、工作流模板。
- 调试 agent trace、tool calls、prompt、上下文和成本。

---

## 3. 产品模式设计

### 3.1 普通办公模式 Office Mode

默认开启。面向非技术用户。

用户看到的是任务模板和交付物，不看到命令行。

功能：

- [MVP] 选择本地文件夹 / 文件
- [MVP] 信任目录授权
- [MVP] 文件树、搜索、筛选
- [MVP] 文档摘要、分类、提取、归档
- [MVP] 生成 Markdown / CSV / XLSX 初稿
- [MVP] 文件重命名 / 移动预览
- [MVP] 审批后执行
- [MVP] 回滚
- [MVP] 审计日志

禁止：

- 默认执行 shell
- 默认读取全盘
- 默认读取系统目录、凭据、浏览器 Cookie
- 默认删除文件
- 默认自动发邮件 / 提交表单

### 3.2 本地增强模式 Local Agent Mode

面向高级办公用户。

功能：

- [V1] 批量处理文件夹
- [V1] 本地索引和全文搜索
- [V1] 多文档引用追踪
- [V1] Excel 清洗 / 汇总 / 透视表建议
- [V1] Word/PPT 产物生成
- [V1] 浏览器本地辅助能力，可后续接入 WebBridge 类能力
- [V1] WPS / Office 打开与导出辅助

### 3.3 开发者模式 Developer Mode

默认关闭，需要用户显式开启。

功能：

- [MVP] 允许配置 Moonshot/Kimi API Key
- [MVP] 允许配置 LiteLLM / OpenAI-compatible base URL
- [MVP] 允许选择模型：Kimi 默认，其他模型作为可选
- [V1] Kimi CLI 检测与启动
- [V1] Kimi Web 安全启动器
- [V1] ACP / MCP / 插件管理
- [V1] 自定义工具 JSON Schema
- [V1] 本地脚本工具，但必须审批
- [V1] Agent trace 调试面板
- [V1] Prompt 模板版本管理

开发者模式权限原则：

- 不影响普通办公模式的安全边界。
- 所有高风险工具默认审批。
- Shell、MCP、脚本、网络访问必须有单独开关和审计。

---

## 4. 核心场景与任务模板

### 4.1 MVP 首批 8 个模板

#### 模板 1：整理文件夹

输入：

> 把这个文件夹按客户、项目、日期整理，并把命名不规范的文件改成统一格式。

输出：

- 文件分类说明
- 重命名建议
- 移动建议
- 操作预览
- 用户确认后执行
- 可回滚

状态：`[MVP] [ ]`

#### 模板 2：会议纪要转行动项

输入：

> 从这些会议纪要中提取行动项、负责人、截止日期和风险。

输出：

- action_items.xlsx
- meeting_summary.md
- 待确认事项

状态：`[MVP] [ ]`

#### 模板 3：合同/协议摘要

输入：

> 从这些合同中提取甲乙方、金额、付款、违约、续约、保密、管辖条款。

输出：

- contract_summary.xlsx
- risk_report.md
- 原文引用位置

状态：`[MVP] [ ]`

#### 模板 4：报销 / 发票整理

输入：

> 把这些发票、收据和报销截图整理成报销表。

输出：

- reimbursement.csv / xlsx
- 缺失材料清单
- 可疑金额 / 日期提醒

状态：`[MVP] [ ]`

#### 模板 5：客户反馈分类

输入：

> 把这些客户反馈按问题类型分类，找出 Top 问题和建议动作。

输出：

- feedback_clusters.xlsx
- action_plan.md

状态：`[MVP] [ ]`

#### 模板 6：多文档总结报告

输入：

> 根据这些材料生成一份结构化报告。

输出：

- summary_report.md
- 引用来源
- 待确认问题

状态：`[MVP] [ ]`

#### 模板 7：Excel 数据清洗

输入：

> 清洗这张表，统一日期格式，找出重复项、缺失项和异常值。

输出：

- cleaned.xlsx
- data_issues.md

状态：`[MVP] [ ]`

#### 模板 8：邮件 / 通知草稿

输入：

> 根据这些材料写一封通知邮件，语气正式，列出事项和截止日期。

输出：

- email_draft.md
- 不自动发送，仅生成草稿

状态：`[MVP] [ ]`

---

## 5. 最新 MVP 边界

### 5.1 MVP 必须做

- [ ] Windows 桌面应用
- [ ] 登录 / 本地身份
- [ ] 选择文件夹
- [ ] 信任目录
- [ ] 文件树展示
- [ ] 文件搜索
- [ ] 读取 PDF / DOCX / XLSX / CSV / TXT / Markdown
- [ ] Kimi API 调用
- [ ] Kimi Tool Calls Loop
- [ ] JSON Mode 计划生成
- [ ] 任务模板
- [ ] 执行进度展示
- [ ] 交付物生成
- [ ] 文件操作 diff / preview
- [ ] 用户审批
- [ ] 文件重命名 / 移动
- [ ] 回滚日志
- [ ] 审计日志
- [ ] 开发者模式入口
- [ ] 多模型配置入口，但 MVP 只需实现 OpenAI-compatible adapter

### 5.2 MVP 不做

- [ ] 不做全盘扫描
- [ ] 不做默认删除文件
- [ ] 不做默认 shell 执行
- [ ] 不做公网暴露本地 Web UI
- [ ] 不做自动发邮件
- [ ] 不做自动登录企业系统
- [ ] 不做复杂团队 SaaS
- [ ] 不做完整插件市场
- [ ] 不做 VM / Hyper-V 隔离，先做进程级边界、审批、审计

---

## 6. 技术架构总览

### 6.1 产品主线架构

```text
Windows Desktop App
  ├─ Office Mode UI
  ├─ File Workspace
  ├─ Approval Center
  ├─ Artifact Viewer
  └─ Developer Mode UI

Local Agent Service
  ├─ File Tools
  ├─ Document Extractor
  ├─ Diff / Apply / Rollback
  ├─ Audit Logger
  ├─ Local Index
  ├─ Kimi CLI Bridge, optional
  └─ Model Router, optional

Cloud / API Layer, optional in MVP but reserved
  ├─ Auth
  ├─ Task Sync
  ├─ Model Gateway
  ├─ Billing / Quota
  ├─ Team Policy
  └─ Telemetry / Audit Sync

Model Layer
  ├─ Kimi API, default
  ├─ Kimi CLI / Kimi Web, developer mode
  ├─ LiteLLM / OpenAI-compatible adapter
  ├─ Other LLMs, developer mode
  └─ Local LLMs, future
```

### 6.2 推荐技术栈

#### Windows 客户端

推荐正式产品主线：

```text
C/C++ + Win32 + WebView2
```

原因：

- 适合 Windows 主流用户。
- 比 Electron 更轻。
- 可以保持本地原生能力。
- WebView2 负责复杂 UI，C/C++ 负责窗口、托盘、本地桥接、安装器、权限。

PoC 可以继续用：

```text
TypeScript + Electron
```

但建议将其定位为 `MVP-0 / 内部验证版`，不是最终产品主线。

#### Local Agent

推荐：

```text
Go
```

原因：

- 文件处理、并发、WebSocket、HTTP、单文件分发方便。
- 比 Python 更适合 Windows 分发。
- 比纯 C 更容易开发和维护本地 agent。

#### 文档处理

MVP：

```text
Go + Python Worker 可选
```

- PDF：pypdf / pymupdf / pdfium
- DOCX：python-docx 或 zip+xml 解析
- XLSX：openpyxl
- CSV：内置解析
- PPTX：python-pptx，V1 加

#### 模型网关

MVP：

```text
Kimi API adapter + OpenAI-compatible adapter
```

V1：

```text
LiteLLM Proxy / 自研 Model Router
```

#### 数据存储

本地 MVP：

```text
SQLite + JSONL + 本地缓存目录
```

云端 V1：

```text
PostgreSQL + Redis + NATS + S3/MinIO + ClickHouse
```

---

## 7. 两阶段实现策略

### 7.1 MVP-0：快速验证版，2-3 周

目标：验证产品逻辑，而不是追求最终技术栈完美。

可以基于你已有的 TypeScript/Electron/Kimi CLI 本地计划继续推进。

范围：

- [ ] Kimi CLI 检测
- [ ] 本地 Host API
- [ ] 信任目录
- [ ] 文件树
- [ ] 文件上下文
- [ ] Kimi Web 安全启动
- [ ] 审计日志
- [ ] 简单 Web UI
- [ ] 1-2 个办公模板

适合用途：

- 验证用户是否需要这个中间产品。
- 验证普通用户是否理解“信任目录、审批、预览、回滚”。
- 验证 Kimi CLI / Web UI 能否作为底层能力桥接。

风险：

- [!] Electron 与 Node 本地服务不是最终轻量 Windows 架构。
- [!] 过度依赖本机 Kimi CLI，不适合所有白领用户。
- [!] Kimi CLI 是开发者工具，办公用户体验需要重新包装。

### 7.2 MVP-1：正式办公版，6-8 周

目标：做成真正面向白领的 Windows 产品。

范围：

- [ ] Windows C/C++ + WebView2 客户端
- [ ] Go Local Agent
- [ ] Kimi API 默认调用
- [ ] OpenAI-compatible adapter
- [ ] 本地文件工具
- [ ] 文档解析工具
- [ ] 任务模板
- [ ] 审批中心
- [ ] 文件 diff/apply/rollback
- [ ] 本地审计日志
- [ ] 开发者模式
- [ ] Kimi CLI Bridge 可选开启

---

## 8. 办公用户体验设计

### 8.1 首页

```text
左侧：工作区 / 最近任务 / 模板 / 开发者模式
中间：任务输入 + 模板卡片
右侧：待审批 / 最近产物 / 安全状态
底部：任务进度、模型、成本估计
```

### 8.2 工作区页面

展示：

- 当前信任目录
- 文件树
- 文件搜索
- 文件类型筛选
- 最近变更
- 可加入上下文的文件
- 被拦截的敏感文件

### 8.3 任务执行页

展示：

- 用户目标
- Agent 计划
- 当前步骤
- 已读取文件
- 工具调用
- 生成的交付物
- 需要用户确认的操作

### 8.4 审批中心

审批类型：

- 文件读取越界
- 大文件加入上下文
- 文件写入
- 文件移动
- 文件重命名
- 覆盖文件
- Shell 命令
- 网络访问
- MCP 工具
- 插件工具

### 8.5 交付物中心

交付物类型：

- Markdown 报告
- CSV / XLSX 表格
- Word 初稿
- PPT 大纲
- 文件整理方案
- 合同风险清单
- 会议行动项
- 邮件草稿

---

## 9. Agent Runtime 设计

### 9.1 状态机

```text
created
  ↓
scoping
  ↓
planning
  ↓
awaiting_plan_approval
  ↓
executing
  ↓
awaiting_tool_approval
  ↓
verifying
  ↓
drafting
  ↓
awaiting_commit_approval
  ↓
committing
  ↓
completed
```

失败状态：

```text
failed
cancelled
timeout
permission_denied
quota_exceeded
model_error
device_error
```

### 9.2 计划 JSON

```json
{
  "task_type": "folder_organize",
  "summary": "整理客户资料文件夹",
  "risk_level": "medium",
  "steps": [
    {
      "step_id": "s1",
      "name": "扫描文件夹",
      "tool": "list_files",
      "requires_approval": false
    },
    {
      "step_id": "s2",
      "name": "分析文件命名和内容",
      "tool": "read_file_batch",
      "requires_approval": false
    },
    {
      "step_id": "s3",
      "name": "生成移动和重命名方案",
      "tool": "propose_file_operations",
      "requires_approval": true
    }
  ],
  "expected_outputs": [
    {
      "type": "markdown",
      "name": "整理说明"
    },
    {
      "type": "file_operations",
      "name": "文件操作预览"
    }
  ]
}
```

### 9.3 工具清单

#### MVP 本地工具

- [ ] `list_files(root, filters)`
- [ ] `read_file(path, max_bytes)`
- [ ] `extract_text(path)`
- [ ] `search_files(query)`
- [ ] `propose_file_operations(ops)`
- [ ] `apply_approved_operations(approval_id)`
- [ ] `rollback_operations(batch_id)`
- [ ] `write_artifact(name, content)`
- [ ] `generate_csv(rows)`
- [ ] `generate_xlsx(sheets)`

#### V1 工具

- [ ] `extract_docx_rich(path)`
- [ ] `extract_pptx(path)`
- [ ] `generate_docx(content)`
- [ ] `generate_pptx(outline)`
- [ ] `office_open(path)`
- [ ] `wps_open(path)`
- [ ] `browser_fetch(url)`
- [ ] `web_search(query)`

#### 开发者模式工具

- [ ] `run_shell_command(command, cwd)`，默认审批
- [ ] `mcp_call(server, tool, args)`，默认审批
- [ ] `custom_tool_call(tool_id, args)`，默认审批
- [ ] `kimi_cli_session_start(workspace)`
- [ ] `kimi_web_start(workspace)`

---

## 10. 安全与权限设计

### 10.1 信任目录

原则：

- 用户选择目录后只是挂载，不自动信任。
- 用户点击“信任此工作区”后，才允许读取普通文件。
- 所有路径都必须 canonicalize。
- Windows 路径比较大小写不敏感。
- 只允许访问 trusted root 内部路径。

### 10.2 默认拦截

默认拦截：

- `.ssh`
- `.kimi/credentials`
- `.env`
- `*.pem`
- `*.key`
- `id_rsa`
- 浏览器 Cookie
- AppData 敏感目录
- Windows 系统目录
- 大型二进制文件

### 10.3 高风险操作

必须审批：

- 写文件
- 重命名
- 移动
- 覆盖
- 删除，MVP 禁止
- Shell
- 网络请求
- MCP
- 插件工具
- 模型切换到非默认供应商

### 10.4 回滚

每次文件操作写入 journal：

```json
{
  "batch_id": "batch_001",
  "op_id": "op_001",
  "type": "rename",
  "from": "D:\\Work\\a.docx",
  "to": "D:\\Work\\2026_ClientA_Contract.docx",
  "before_hash": "sha256...",
  "after_hash": "sha256...",
  "status": "done"
}
```

---

## 11. 开发者模式设计

### 11.1 模型配置

配置入口：

```text
设置 → 开发者模式 → 模型提供商
```

支持：

- [MVP] Kimi API
- [MVP] OpenAI-compatible Base URL
- [V1] LiteLLM Proxy
- [V1] OpenAI
- [V1] Gemini
- [V1] DeepSeek
- [V1] Qwen
- [V1] Ollama / vLLM

配置字段：

```json
{
  "provider": "openai_compatible",
  "name": "local-litellm",
  "base_url": "http://127.0.0.1:4000/v1",
  "api_key_ref": "windows_credential_manager:model_key_001",
  "models": ["kimi-k2.6", "deepseek-chat", "qwen-max"]
}
```

### 11.2 模型路由策略

普通办公模式：

```text
默认只用 Kimi。
```

开发者模式：

```text
简单分类 / 抽取：低成本模型
复杂推理 / 报告：Kimi K2.6
代码 / shell：Kimi CLI 或 coding model
本地隐私任务：本地模型
```

### 11.3 MCP 与插件

MVP 只展示配置，不开放插件市场。

V1 增加：

- MCP server 列表
- tool 白名单
- tool 风险等级
- per-tool 审批策略
- 审计日志

---

## 12. 云端与多用户扩展规划

MVP 可以先本地单机，但架构必须预留云端。

### 12.1 V1 云端组件

- [ ] Auth Service
- [ ] Device Registry
- [ ] Task Sync Service
- [ ] Model Gateway
- [ ] Billing / Quota
- [ ] Team Policy
- [ ] Audit Sync
- [ ] Artifact Storage

### 12.2 V2 多租户架构

```text
API Gateway
  ↓
Go API Service
  ↓
Task Orchestrator
  ↓
Device Relay Service
  ↓
Windows Local Agent

Model Gateway
  ├─ Kimi
  ├─ LiteLLM
  ├─ OpenAI-compatible Providers
  └─ Local Model Connectors

Data Layer
  ├─ PostgreSQL
  ├─ Redis
  ├─ NATS / Kafka
  ├─ S3 / MinIO
  ├─ ClickHouse
  └─ Vector DB
```

### 12.3 千万级 QPS 的正确拆解

不要把千万级 QPS 理解成千万级模型调用。

拆成：

```text
控制面 QPS：登录、任务状态、事件、设备心跳
任务面 QPS：任务创建、审批、工具请求、artifact 查询
事件面 QPS：日志、审计、trace
模型面 QPS：Kimi/其他模型请求，受供应商额度和成本限制
```

长期目标：

- [ ] 控制面可水平扩容到千万级 QPS
- [ ] 事件面采用 Kafka / NATS 分区与批量写入
- [ ] 模型面采用队列、预算、限流、缓存、熔断
- [ ] 单任务全链路 trace
- [ ] 租户级限流
- [ ] 用户级预算
- [ ] 工具调用幂等

---

## 13. 数据结构

### 13.1 本地 SQLite 表

```sql
workspaces
  id
  path
  trust_state
  created_at
  updated_at

tasks
  id
  workspace_id
  title
  user_goal
  status
  mode
  created_at
  updated_at

task_events
  id
  task_id
  seq
  event_type
  payload_json
  created_at

approvals
  id
  task_id
  approval_type
  status
  payload_json
  decided_at

artifacts
  id
  task_id
  type
  name
  local_path
  content_hash
  created_at

file_operations
  id
  task_id
  batch_id
  op_type
  from_path
  to_path
  status
  before_hash
  after_hash
  created_at

audit_logs
  id
  task_id
  kind
  message
  payload_json
  created_at
```

### 13.2 本地目录

```text
%APPDATA%\KimiCowork\
├── config.json
├── trusted-roots.json
├── model-providers.json
├── sessions\
│   └── <session-id>\
│       ├── metadata.json
│       ├── events.jsonl
│       ├── audit.jsonl
│       ├── approvals.jsonl
│       ├── pending-diffs\
│       ├── artifacts\
│       └── rollback\
└── cache\
    ├── extracted-text\
    ├── file-index\
    └── thumbnails\
```

---

## 14. 版本路线图

### 14.1 MVP-0：内部 PoC，2-3 周

- [ ] 使用现有 TypeScript/Electron 计划快速跑通
- [ ] Kimi CLI 检测
- [ ] 信任目录
- [ ] Kimi Web 安全启动
- [ ] 简单文件树
- [ ] 审计日志
- [ ] 一个“文件夹整理”模板
- [ ] 一个“多文档总结”模板

验收：

- [ ] 普通用户能选择文件夹并生成总结
- [ ] 不信任目录不能读取
- [ ] Kimi Web 不使用公网危险参数
- [ ] 所有高风险动作有日志

### 14.2 MVP-1：办公正式版，6-8 周

- [ ] Windows C/C++ + WebView2 客户端
- [ ] Go Local Agent
- [ ] Kimi API adapter
- [ ] OpenAI-compatible adapter
- [ ] 8 个办公模板
- [ ] 文档解析
- [ ] 文件操作 diff/apply/rollback
- [ ] 审批中心
- [ ] Artifact Center
- [ ] Developer Mode 初版

验收：

- [ ] 10 个真实办公用户，每人完成 3 个任务
- [ ] 文件误操作率为 0
- [ ] 高风险操作审批率 100%
- [ ] 至少 5 类文件可处理
- [ ] 每个任务有审计日志

### 14.3 V1：团队办公版，8-12 周

- [ ] 团队空间
- [ ] 企业模板
- [ ] 管理员策略
- [ ] 模型预算
- [ ] 云端任务同步
- [ ] 企业网盘连接器
- [ ] 飞书 / 钉钉 / 企微 / WPS 连接器
- [ ] LiteLLM Model Router
- [ ] MCP 工具策略

### 14.4 V2：企业版

- [ ] 私有部署
- [ ] SSO
- [ ] SCIM
- [ ] 审计导出
- [ ] DLP
- [ ] 私有对象存储
- [ ] 多租户隔离
- [ ] 高并发云端架构
- [ ] 内网部署

---

## 15. 当前上传计划的处理建议

你已有的计划不应该废弃，而应改名为：

```text
MVP-0: Kimi CLI 本地验证版
```

保留其中这些内容：

- Kimi-only 能力边界
- 本地目录信任
- 受控文件读取
- diff/apply pipeline
- command runner 审批
- Kimi Web 安全启动器
- Kimi Skills/Plugins/MCP 管理入口
- JSONL 审计日志

需要调整：

- Electron/React 不作为长期正式客户端主线
- Node Host API 不作为长期后端主线
- 加入 Office Mode 的白领模板
- 开发者模式变成显式开关
- 增加 Kimi API 默认路径，不强依赖本机 Kimi CLI
- 增加 OpenAI-compatible 多模型 adapter

---

## 16. 最终推荐执行顺序

### 第 1 步：保留 MVP-0，快速验证

- [ ] 继续实现你上传计划中的 Tasks 1-7
- [ ] 不急着完善 Electron UI
- [ ] 先验证 Kimi CLI / Web / 信任目录 / 审批 / 审计

### 第 2 步：并行设计 MVP-1 架构

- [ ] Windows C/C++ + WebView2 客户端设计
- [ ] Go Local Agent 设计
- [ ] Kimi API adapter 设计
- [ ] OpenAI-compatible adapter 设计
- [ ] 8 个办公模板 PRD

### 第 3 步：MVP-1 替换 MVP-0 UI 和 Runtime

- [ ] 把 MVP-0 中验证通过的能力迁移到 Go Local Agent
- [ ] 把 Electron UI 替换成 WebView2 UI
- [ ] 普通用户默认使用 Office Mode
- [ ] 开发者模式保留 Kimi CLI Bridge

### 第 4 步：准备团队版

- [ ] 设计云端 API
- [ ] 设计 Device Relay
- [ ] 设计 Model Gateway
- [ ] 设计计费、限流、审计同步

---

## 17. 关键产品原则

1. **办公用户优先**：用户不需要知道 CLI、MCP、API Key。
2. **本地文件可控**：只处理用户授权目录。
3. **先预览，后执行**：文件操作必须 preview。
4. **可回滚**：所有写入、移动、重命名都要记录 journal。
5. **开发者模式隔离**：默认关闭，开启后也要审批。
6. **Kimi 默认，多模型可选**：不要一开始做成泛模型工具，但要预留 router。
7. **交付物导向**：重点不是聊天，而是报告、表格、文件整理方案、行动项。
8. **安全比自动化更重要**：宁可多一步确认，也不能误删、误改、误传。

---

## 18. 推荐产品名称

可选：

- Agent Coworker
- Kimi Local Office
- Kimi Workbench
- Kimi Desk Agent
- Kimi Office Agent
- LunaWork
- MoonDesk

注意：如果没有 Kimi / Moonshot 官方授权，正式商业命名应避免让用户误解为官方产品。

---

## 19. 外部资料参考

- Kimi API Overview: https://platform.kimi.ai/docs/api/overview
- Kimi K2.6 Quickstart: https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart
- Kimi Tool Calls: https://platform.kimi.ai/docs/guide/use-kimi-api-to-complete-tool-calls
- Kimi JSON Mode: https://platform.kimi.ai/docs/guide/use-json-mode-feature-of-kimi-api
- Kimi File-Based Q&A: https://platform.kimi.ai/docs/guide/use-kimi-api-for-file-based-qa
- Kimi Code Web UI: https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-web.html
- LiteLLM Proxy: https://docs.litellm.ai/docs/
