# Agent Cowork 2.0 功能添加方案

**主题：参考 Claude Cowork 式协作体验，新增国产模型适配、新手配置教学、Skills、Recipes、Hooks 三套扩展机制**  
**版本：v1.0**  
**日期：2026-07-02**  
**适用项目：Agent Cowork**

---

## 0. 文档目的

本方案用于把当前 Agent Cowork 从“本地 Agentic MVP + Kimi 计划生成”升级为更完整的 **Local-First Cowork SaaS 产品底座**。

本次功能添加重点有四个：

1. **参考 Claude Cowork 式任务协作体验**：从普通聊天升级为“任务、计划、审批、执行、产物、审计”的完整工作流。
2. **支持大陆绝大多数大模型配置**：从 Kimi 专用接口升级为通用 `ModelRouter`，优先兼容 OpenAI Chat Completions 风格接口，同时支持本地模型和企业内网模型网关。
3. **配置开头的新手教学**：首次启动时用 7 步向导讲清楚本地安全模式、云模型边界、工作区权限、审批机制和第一个示例任务。
4. **新增 Skills / Recipes / Hooks 体系**：让产品从“一次性 prompt”升级为可复用、可组合、可审计、可插件化的 Agent 工作台。

本方案遵循一个核心原则：

> **Agent Cowork 的默认形态不是云端 AI SaaS，而是 Local-First Cowork Agent。云端可以作为控制平面、授权平面、模型选项或企业策略同步层；真实文件处理、任务执行、审计和回滚默认留在本地。**

---

## 1. 当前项目基线判断

根据当前 README，项目已经具备较好的产品化基础：

- 已有 **Agentic tool-calling loop**，模型可以自主决策调用 `Read / Write / Edit / Glob / Grep / Shell / WebFetch` 等工具。
- 已有 **Plan Mode**，写操作需要先生成可审批计划，用户批准后才执行。
- 已有 **MCP 协议栈**，工具命名空间采用 `mcp__<server>__<tool>`。
- 已有 **trusted root jail / 敏感段黑名单 / symlink 解析 / redaction / JWT / SSRF 守卫 / Host 白名单 / shell:false** 等安全边界。
- 已有 SQLite / PostgreSQL 双存储、任务运行记录、审计、产物面板、上传导入、连接器、GitHub OAuth 凭证仓库、Docker `--network=none` 沙箱验证等基础能力。
- 已有 `summary-report` recipe，能够在 trusted root 下生成 Markdown、DOCX、PPTX、PDF 产物。
- 当前 Kimi API 计划生成仍偏专用，接口为 `/api/agent-engine/chat` 和 `/api/agent-engine/plan`，需要升级为 provider-neutral 的模型路由。

因此，下一阶段不需要重写核心 Agent，而应做 **能力抽象、配置产品化、模板产品化、安全策略统一化**。

---

## 2. 目标定位

### 2.1 一句话定位

> **Agent Cowork 2.0 是一个面向中文、本地文件和大陆模型生态的 Local-First Cowork Agent：用户提出目标，系统先生成计划，用户审批后再读取、整理、生成和修改本地资料。**

### 2.2 与普通聊天助手的区别

| 维度 | 普通聊天助手 | Agent Cowork 2.0 |
|---|---|---|
| 交互中心 | 对话 | 任务 |
| 输出形式 | 一段回答 | 文件、报告、表格、PPT、审计、回滚 |
| 文件处理 | 上传到云端或复制文本 | 只访问用户选择的 trusted root |
| 执行方式 | 模型直接回答 | 计划 → 审批 → 工具执行 → 自检 → 落盘 |
| 安全边界 | 模型服务商策略为主 | 本地策略引擎 + Hook + 审批 + 沙箱 |
| 模型选择 | 绑定单一服务商 | ModelRouter 支持本地/国产云/企业网关/自定义接口 |
| 可复用性 | prompt 复用困难 | Skills / Recipes / Hooks 可版本化复用 |

### 2.3 目标用户

1. 中文知识工作者：需要整理本地文档、会议记录、调研材料、客户资料。
2. 中小企业团队：需要“文件留本地、结果可审计”的 AI 协作工具。
3. 开发团队：需要本地代码分析、改造计划、补丁生成和安全审查。
4. 政企/金融/法律/医疗等敏感行业：需要本地严格模式或企业内网模型网关。
5. AI 工具集成商：需要可配置国产模型、可扩展 workflow、可审计 Agent 执行链。

---

## 3. 总体架构

### 3.1 目标架构图

```txt
┌─────────────────────────────────────────────────────────────────────┐
│                         Agent Cowork UI                              │
│  Onboarding │ Task Center │ Artifacts │ Model Settings │ Audit       │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────┐
│                         Host API / Local Control                     │
│  Auth │ Workspace │ Runs │ Approvals │ Policies │ Settings          │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────┐
│                         Agent Orchestrator                           │
│  Plan Mode │ Agent Loop │ Subagents │ Context Pack │ Audit Stream    │
└───────────────┬───────────────────────┬─────────────────────────────┘
                │                       │
┌───────────────▼──────────────┐ ┌──────▼──────────────────────────────┐
│       Extension Layer         │ │             Model Layer              │
│  Skills │ Recipes │ Hooks     │ │ ModelRouter │ ProviderRegistry       │
│  Plugins │ MCP manifests      │ │ CapabilityProbe │ SecretStore         │
└───────────────┬──────────────┘ └──────┬──────────────────────────────┘
                │                       │
┌───────────────▼───────────────────────▼─────────────────────────────┐
│                         Local Data Plane                              │
│  Read/Write/Edit │ Glob/Grep │ Shell Sandbox │ WebFetch Guard          │
│  Trusted Root Jail │ Redaction │ Audit │ Rollback │ Artifacts           │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 三条主线

1. **模型主线**：`/api/agent-engine/*` → `/api/llm/*` → `ModelRouter` → 多 provider。
2. **任务主线**：用户输入 → Task Template / Recipe 选择 → Plan → Approval → Tool calls → Artifacts。
3. **安全主线**：Security Mode → Policy Engine → Hooks → Approval → Audit → Rollback。

---

## 4. 运行模式与隐私边界

### 4.1 三种安全模式

| 模式 | 默认模型 | 本地文件是否离开本机 | 适用场景 |
|---|---|---|---|
| `local_strict` 本地严格 | Ollama / LM Studio / vLLM / 企业内网模型 | 不允许外发 | 合同、客户资料、源代码、内部知识库 |
| `enterprise_hybrid` 企业混合 | 企业网关或白名单云模型 | 只有审批后的片段/摘要可外发 | 团队协作、低敏文档、可控云推理 |
| `cloud_opt_in` 云端增强 | Kimi / DeepSeek / 通义 / 智谱 / 豆包等 | 用户授权后可外发上下文 | 低敏资料、追求模型效果 |

### 4.2 必须写进 UI 的真实边界

只要使用公网模型 API，不管是 Kimi、DeepSeek、通义千问、智谱、豆包、混元、千帆、MiniMax、讯飞星火还是硅基流动，被发送到模型的 prompt、文件摘要、上下文片段都会离开本机。

所以 UI 必须明确显示：

```txt
🔒 本地严格：模型和文件处理都在本机或内网，禁止公网模型。
🟡 混合可控：文件留本地，片段/摘要经你确认后可发送给云模型。
☁️ 云端增强：允许云模型处理任务上下文，不适合高敏资料。
```

---

## 5. 大陆模型适配方案：ModelRouter

### 5.1 改造目标

当前 Kimi 专用接口应保留兼容，但内部改为通用模型入口：

```txt
旧接口：
POST /api/agent-engine/chat
POST /api/agent-engine/plan

新接口：
GET  /api/models/providers
POST /api/models/providers
POST /api/models/test
POST /api/models/capabilities/probe
POST /api/llm/chat
POST /api/llm/plan
POST /api/llm/stream
```

兼容策略：

```txt
/api/agent-engine/chat  → 内部转发到 /api/llm/chat，providerId = moonshot-kimi
/api/agent-engine/plan  → 内部转发到 /api/llm/plan，providerId = moonshot-kimi
```

### 5.2 Provider 抽象

```ts
export type ProviderProtocol =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-chat'
  | 'local-openai'
  | 'native'

export type ModelProviderConfig = {
  id: string
  displayName: string
  region: 'cn' | 'global' | 'local' | 'enterprise'
  protocol: ProviderProtocol
  baseURL: string
  apiKeyRef?: string
  apiKeyEnv?: string
  defaultModel: string
  enabled: boolean
  allowCloudContext: boolean
  allowToolCalling: boolean
  allowVision: boolean
  allowStreaming: boolean
  allowJsonMode: boolean
  allowReasoning: boolean
  requestTimeoutMs: number
  maxRetries: number
  extraHeaders?: Record<string, string>
  extraBody?: Record<string, unknown>
  safety: {
    allowedInModes: Array<'local_strict' | 'enterprise_hybrid' | 'cloud_opt_in'>
    requireContextEgressApproval: boolean
    redactSecretsBeforeSend: boolean
  }
}
```

### 5.3 首批内置 provider presets

> 注意：各厂商模型名、地域、计费方式会更新，产品内置的是“连接模板”，不是永久模型清单。最终模型名应允许用户手动填写，并通过 capability probe 自动检测。

| Provider ID | 名称 | 协议 | Base URL 示例 | API Key 环境变量 | 模型示例 / 填写方式 | 备注 |
|---|---|---|---|---|---|---|
| `qwen-dashscope-cn` | 通义千问 / 阿里云百炼 | `openai-chat` | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` | `qwen-plus-latest` / 控制台模型名 | 北京区推荐 workspace 专属域名；也可支持新加坡等地域 |
| `deepseek` | DeepSeek | `openai-chat` / `anthropic-chat` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | `deepseek-v4-flash` / `deepseek-v4-pro` | 同时支持 OpenAI/Anthropic 风格；旧模型名需做兼容提示 |
| `moonshot-kimi` | Kimi / Moonshot | `openai-chat` | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` 或 `KIMI_API_KEY` | `kimi-k2.6` / `kimi-latest` | 当前 Kimi 专用接口迁移到此 provider |
| `zai-glm` | 智谱 / Z.AI / GLM | `openai-chat` | `https://api.z.ai/api/paas/v4` 或账号指定 endpoint | `ZAI_API_KEY` | `glm-5.2` / 控制台模型名 | Coding Plan 可能有专用 endpoint |
| `baidu-qianfan` | 百度千帆 ModelBuilder | `openai-chat` | `https://qianfan.baidubce.com/v2` | `QIANFAN_API_KEY` | 千帆控制台模型名 | v2 OpenAI 兼容优先 |
| `volcengine-ark` | 火山方舟 / 豆包 | `openai-chat` | `https://ark.cn-beijing.volces.com/api/v3` | `ARK_API_KEY` | endpoint id / model id | 常见做法是把 endpoint id 填入 model |
| `tencent-hunyuan` | 腾讯混元 | `openai-chat` | `https://api.hunyuan.cloud.tencent.com/v1` | `HUNYUAN_API_KEY` | `hunyuan-turbos-latest` | 支持 `extra_body` 传入腾讯扩展参数 |
| `minimax` | MiniMax | `openai-chat` / `anthropic-chat` | `https://api.minimaxi.com/v1` | `MINIMAX_API_KEY` | `MiniMax-M3` | 多模态、thinking 参数需要 capability probe |
| `iflytek-spark` | 讯飞星火 | `openai-chat` | `https://spark-api-open.xf-yun.com/v1/` | `SPARK_API_KEY` | `generalv3.5` / `Ultra` / 控制台模型名 | 注意不同版本上下文长度和套餐差异 |
| `siliconflow-cn` | 硅基流动 | `openai-chat` | `https://api.siliconflow.cn/v1` | `SILICONFLOW_API_KEY` | `Qwen/*` / `deepseek-ai/*` / `Pro/zai-org/*` | 适合作为多开源模型聚合入口 |
| `local-ollama` | Ollama 本地模型 | `local-openai` | `http://127.0.0.1:11434/v1` | 空或占位 | 本地已拉取模型 | `local_strict` 默认推荐 |
| `local-lmstudio` | LM Studio 本地模型 | `local-openai` | `http://127.0.0.1:1234/v1` | 空或占位 | LM Studio 当前加载模型 | 新手低门槛本地模式 |
| `local-vllm` | vLLM 本地/内网服务 | `local-openai` | `http://127.0.0.1:8000/v1` | 可选 | serve 时指定模型 | 适合企业 GPU 服务器 |
| `custom-openai-compatible` | 自定义 OpenAI 兼容服务 | `openai-chat` | 用户填写 | 用户填写 | 用户填写 | 覆盖企业网关、One API、New API、ModelScope、私有 MaaS 等 |

### 5.4 Capability Probe

国产模型虽然大多支持 OpenAI 兼容格式，但能力差异很大，不能只靠静态配置。保存 provider 前必须自动测试：

```txt
1. 鉴权测试：最小 chat completion 或 /models。
2. 流式测试：stream=true 是否返回可解析 SSE。
3. JSON 测试：要求返回 {"ok": true}。
4. Tool Calling 测试：提供 harmless function，看是否返回 tool_calls。
5. Vision 测试：仅当用户启用多模态时发送小图。
6. Reasoning 测试：检测 reasoning_content / reasoning_details / thinking / <think>。
7. Context Egress 策略测试：当前安全模式是否允许该 provider。
8. Token/长度测试：检测 provider 返回的最大上下文、截断行为或错误格式。
```

测试结果应写入：

```ts
export type ModelCapabilityReport = {
  providerId: string
  model: string
  checkedAt: string
  ok: boolean
  text: CapabilityStatus
  streaming: CapabilityStatus
  jsonMode: CapabilityStatus
  toolCalling: CapabilityStatus
  vision: CapabilityStatus
  reasoning: CapabilityStatus
  modelList: CapabilityStatus
  errorShape: 'openai' | 'provider-specific' | 'unknown'
  notes: string[]
}
```

UI 展示示例：

```txt
DeepSeek / deepseek-v4-pro
✅ 鉴权通过
✅ 文本对话
✅ 流式输出
✅ JSON 输出
⚠️ Tool Calling：兼容但建议启用工具调用降级策略
❌ Vision：当前模型未检测到视觉能力
🔐 云模型：发送本地上下文前需要用户确认
```

### 5.5 密钥处理

密钥必须遵循以下规则：

```txt
- API Key 只存 Host SecretStore，不进入前端状态。
- 前端只拿 providerId、displayName、maskedKey、capabilityReport。
- run/audit/artifact 中永远不写入原始 key。
- redaction 要覆盖 Authorization、api-key、x-api-key、Bearer token、sk-*、moonshot-* 等格式。
- 导出诊断报告时默认移除 baseURL query、headers、extraBody 中的敏感字段。
```

---

## 6. 首次启动新手教学

### 6.1 目标

新用户第一次打开产品时，不应该直接看到 `.env`、模型 endpoint、trusted root 等技术概念。应通过 7 步向导完成：

1. 理解产品是什么。
2. 选择安全模式。
3. 配置模型或进入本地演示。
4. 选择工作区。
5. 跑第一个示例任务。
6. 学会审批。
7. 进入任务中心。

### 6.2 Onboarding 状态机

```ts
export type OnboardingStep =
  | 'welcome'
  | 'security_mode'
  | 'model_provider'
  | 'model_test'
  | 'workspace'
  | 'demo_task'
  | 'approval_tutorial'
  | 'done'

export type OnboardingState = {
  completed: boolean
  currentStep: OnboardingStep
  securityMode?: 'local_strict' | 'enterprise_hybrid' | 'cloud_opt_in'
  selectedProviderId?: string
  selectedModel?: string
  workspaceRoot?: string
  demoRunId?: string
  dismissedAt?: string
}
```

### 6.3 第 0 步：欢迎页

建议文案：

```txt
欢迎使用 Agent Cowork 👋

它不是普通聊天助手，而是一个本地优先的 AI 协作工作台：
- 只处理你明确选择的工作区
- 读文件、生成计划、等待你审批
- 写入、移动、删除、执行命令前会展示预览
- 所有产物和审计记录默认保存在本地
```

按钮：

```txt
[开始 3 分钟配置]  [跳过，进入本地演示模式]
```

### 6.4 第 1 步：选择安全模式

默认选择：`local_strict`。

```txt
请选择你的隐私模式：

🔒 本地严格
所有模型调用只走本机或内网模型。适合保密文件、合同、客户资料、源代码。

🟡 混合可控
可以使用 Kimi、DeepSeek、通义千问等公网模型，但在发送本地内容前会提醒你确认。

☁️ 云端增强
优先使用公网大模型获得更强效果。注意：被发送给模型的 prompt、文件摘要、上下文片段会离开本机。
```

### 6.5 第 2 步：选择模型

模型选择页分三组：

```txt
本地模型：Ollama / LM Studio / vLLM
国产云模型：DeepSeek / 通义千问 / Kimi / 智谱 / 豆包 / 混元 / 千帆 / MiniMax / 讯飞 / 硅基流动
自定义接口：OpenAI 兼容服务 / 企业网关 / One API / New API / 私有 MaaS
```

无 key 用户提供：

```txt
[进入本地演示模式]
[查看如何获取 API Key]
[配置本地 Ollama]
```

### 6.6 第 3 步：连接测试

新手只显示必要字段：

```txt
API Key: [________________]
模型:    [自动推荐 / 手动填写]
[测试连接]

高级设置：Base URL、Headers、extra_body、超时、重试
```

本地模型只显示：

```txt
本地服务地址：
[ http://127.0.0.1:11434/v1 ]

[检测本地模型]
```

### 6.7 第 4 步：选择工作区

```txt
Agent Cowork 只会访问你选择的这个文件夹。
你可以随时更换工作区。系统不会自动扫描整个电脑。
```

按钮：

```txt
[选择文件夹]  [使用示例工作区]
```

### 6.8 第 5 步：第一个安全示例任务

自动创建示例工作区：

```txt
Agent_Cowork_新手示例/
  会议记录.md
  产品反馈.csv
  项目说明.txt
```

示例任务：

```txt
请读取示例资料，生成一份 1 页项目总结，并保存为 Markdown。
```

执行动态必须展示：

```txt
1. 正在读取：3 个示例文件
2. 正在生成计划：只读分析 + 写入总结
3. 等待审批：将创建 .AgentCowork/artifacts/项目总结.md
4. 审批后执行
5. 生成完成：打开产物 / 查看审计
```

### 6.9 第 6 步：审批教学

```txt
写入、移动、删除、执行命令都需要你确认。
你可以只批准部分步骤，也可以拒绝整个计划。
```

展示 diff preview：

```diff
+ 将创建文件：
+ .AgentCowork/artifacts/项目总结.md

不会修改：
- 原始会议记录.md
- 原始产品反馈.csv
- 原始项目说明.txt
```

### 6.10 第 7 步：完成页

```txt
配置完成 ✅

你现在可以：
- 拖入文件夹，让 Agent Cowork 整理资料
- 生成报告、PPT、表格和审计记录
- 切换模型供应商
- 查看每次任务的运行记录和回滚信息
```

按钮：

```txt
[开始一个真实任务]  [打开模型设置]  [查看安全说明]
```

---

# 7. Skills 设计

## 7.1 Skill 的定义

**Skill 是可复用的能力包**，用于告诉 Agent 在某类任务中应该如何分析、如何选择上下文、允许使用哪些工具、产物应该是什么格式、风险等级是什么。

Skill 不直接执行危险操作。Skill 只能声明需要哪些能力，真正执行仍必须通过 Policy Engine、Hooks、Plan Mode、Approval 和 Tool Registry。

一句话：

> **Skill = 可版本化的专业能力说明 + 工具权限声明 + 上下文打包策略 + 输出格式规范。**

## 7.2 Skill 与 Prompt 的区别

| 维度 | 普通 Prompt | Skill |
|---|---|---|
| 复用 | 靠复制粘贴 | 文件化、版本化、可发现 |
| 安全 | 模型自己遵守 | Host 强制权限与策略 |
| 输入 | 用户临时组织 | 可声明 contextPack 规则 |
| 输出 | 不稳定 | 可声明 artifact schema |
| 工具 | 模型自由尝试 | allowedTools + riskLevel |
| 审计 | 难追踪 | run 记录 skillId/version |

## 7.3 目录结构

```txt
.agent-cowork/
  skills/
    summarize-folder.skill.md
    contract-extract.skill.md
    table-extract.skill.md
    ppt-report.skill.md
    code-review.skill.md
    privacy-check.skill.md
  skills.json
```

也支持项目内置目录：

```txt
apps/host/src/builtin/skills/
  summarize-folder.skill.md
  contract-extract.skill.md
  code-review.skill.md
```

加载优先级：

```txt
1. 当前 workspace 的 .agent-cowork/skills
2. 用户全局配置目录的 skills
3. 应用内置 skills
```

同 ID 冲突时：workspace > user > builtin，但企业策略可以禁止 workspace 覆盖内置安全 skill。

## 7.4 Skill Manifest Schema

Skill 文件采用 Markdown + YAML front matter：

```md
---
id: summarize-folder
name: 文件夹总结
version: 1.0.0
category: knowledge-work
riskLevel: low
allowedTools:
  - Read
  - Glob
  - Grep
  - Write
requiresApproval:
  - Write
contextPack:
  maxFiles: 80
  maxBytesPerFile: 200000
  includeExtensions: [.md, .txt, .csv, .docx, .pdf]
  excludeGlobs:
    - "**/.git/**"
    - "**/node_modules/**"
    - "**/.env"
artifacts:
  - type: markdown
    defaultPath: .AgentCowork/artifacts/文件夹总结.md
policies:
  cloudContext: require_approval
  redactSecrets: true
---

# Skill Instructions

你是一个本地资料总结助手。请优先读取用户指定工作区中的文本资料，输出结构化总结。

必须输出：
1. 资料范围
2. 关键结论
3. 风险与不确定性
4. 建议行动
5. 引用到的本地文件路径
```

对应 TypeScript：

```ts
export type SkillManifest = {
  id: string
  name: string
  version: string
  description?: string
  category: 'knowledge-work' | 'office' | 'code' | 'security' | 'data' | 'custom'
  riskLevel: 'low' | 'medium' | 'high'
  allowedTools: string[]
  deniedTools?: string[]
  requiresApproval: string[]
  contextPack?: {
    maxFiles?: number
    maxBytesPerFile?: number
    includeExtensions?: string[]
    excludeGlobs?: string[]
    citationRequired?: boolean
  }
  artifacts?: Array<{
    type: 'markdown' | 'docx' | 'pptx' | 'xlsx' | 'csv' | 'pdf' | 'json'
    defaultPath: string
    schema?: string
  }>
  policies?: {
    cloudContext?: 'deny' | 'require_approval' | 'allow'
    redactSecrets?: boolean
    requireTrustedRoot?: boolean
    allowShell?: boolean
    allowWebFetch?: boolean
  }
}
```

## 7.5 Skill 生命周期

```txt
1. Discover：扫描 builtin/user/workspace skill 文件。
2. Validate：校验 front matter、版本号、allowedTools、路径、风险等级。
3. Register：写入 SkillRegistry。
4. Match：根据用户任务、文件类型、模板选择合适 skill。
5. Plan：Skill instructions 参与计划生成，但不能绕过 Host 策略。
6. Execute：工具调用由 Policy Engine + Hooks + Approval 控制。
7. Audit：run 中记录 skillId、skillVersion、skillHash。
```

## 7.6 内置 Skills 清单

### 7.6.1 `summarize-folder`

用途：整理并总结一个本地文件夹。

```txt
输入：工作区路径、用户问题、文件过滤规则
输出：Markdown / DOCX 总结
默认工具：Read, Glob, Grep, Write
风险等级：low
审批：写入产物需要审批
```

### 7.6.2 `contract-extract`

用途：从合同、协议、报价单中抽取关键字段。

```txt
输入：合同文件或文件夹
输出：JSON / CSV / XLSX
字段：合同主体、金额、日期、付款方式、违约条款、终止条件、保密条款、风险点
默认工具：Read, Glob, Grep, Write
风险等级：medium
审批：写入表格需要审批；云模型上下文外发必须审批
```

### 7.6.3 `table-extract`

用途：从 PDF、Word、Markdown、CSV 中提取结构化表格。

```txt
输入：文档集合 + 字段 schema
输出：CSV / XLSX / JSON
默认工具：Read, Glob, Grep, Write
风险等级：medium
```

### 7.6.4 `ppt-report`

用途：根据资料生成演示文稿。

```txt
输入：资料文件夹、主题、受众、页数
输出：PPTX + Markdown 讲稿
默认工具：Read, Glob, Grep, Write
风险等级：medium
```

### 7.6.5 `code-review`

用途：分析代码项目，输出结构、风险、改造建议。

```txt
输入：代码工作区、关注问题
输出：Markdown 审查报告，可选 patch plan
默认工具：Read, Glob, Grep
可选工具：Shell 只读命令，如 npm test、npm run check
风险等级：medium/high
审批：Shell、Edit、Write 必须审批
```

### 7.6.6 `privacy-check`

用途：检查工作区是否包含敏感信息或不应外发内容。

```txt
输入：工作区
输出：敏感信息扫描报告
默认工具：Read, Glob, Grep
风险等级：low
特殊策略：默认禁止把命中的敏感内容发给云模型
```

### 7.6.7 `local-rag-briefing`

用途：对本地资料进行问答式检索总结。

```txt
输入：资料库路径 + 问题
输出：带本地引用路径的回答
默认工具：Read, Glob, Grep
风险等级：low
```

### 7.6.8 `project-upgrade-plan`

用途：读取项目 README、代码结构、测试脚本，生成升级计划。

```txt
输入：代码项目路径 + 升级目标
输出：Markdown 计划文档、任务清单、风险列表
默认工具：Read, Glob, Grep, Write
风险等级：medium
```

## 7.7 Skill API

```txt
GET  /api/skills
GET  /api/skills/:skillId
POST /api/skills/validate
POST /api/skills/reload
POST /api/skills/match
```

示例返回：

```json
{
  "skills": [
    {
      "id": "summarize-folder",
      "name": "文件夹总结",
      "version": "1.0.0",
      "source": "builtin",
      "riskLevel": "low",
      "enabled": true
    }
  ]
}
```

## 7.8 Skill 安全规则

```txt
- Skill 不能直接扩大工具权限。
- Skill 声明 allowedTools 只是上限，不是授权。
- 企业策略可以禁用 workspace 自定义 skill。
- 所有 Skill 文件必须计算 hash 并写入 run 审计。
- Skill instructions 不允许包含明文 API Key。
- 如果 Skill 请求 WebFetch / Shell / MCP 高风险工具，必须自动标记 high risk。
- Skill 输出路径必须在 trusted root 内。
```

---

# 8. Recipes 设计

## 8.1 Recipe 的定义

**Recipe 是可执行的任务流程模板**，用于把多个 Skill、工具、审批点、产物和验证步骤组合成一个端到端工作流。

一句话：

> **Recipe = 面向用户结果的工作流模板。Skill 解决“怎么做某类事”，Recipe 解决“按什么步骤交付一个结果”。**

## 8.2 Skill 与 Recipe 的关系

| 项目 | Skill | Recipe |
|---|---|---|
| 粒度 | 能力 | 流程 |
| 示例 | 合同字段抽取 | 批量合同审查并导出风险表 |
| 是否可单独执行 | 可以 | 可以 |
| 是否包含多步骤 | 通常不强制 | 是 |
| 是否定义产物 | 可以 | 必须 |
| 是否定义审批点 | 可以声明 | 必须明确 |

## 8.3 目录结构

```txt
.agent-cowork/
  recipes/
    summary-report.recipe.json
    folder-organizer.recipe.json
    contract-risk-table.recipe.json
    ppt-report.recipe.json
    codebase-audit.recipe.json
```

内置目录：

```txt
apps/host/src/builtin/recipes/
  summary-report.recipe.json
  folder-organizer.recipe.json
  data-extraction.recipe.json
```

## 8.4 Recipe Schema

```ts
export type RecipeManifest = {
  id: string
  name: string
  version: string
  description: string
  category: 'office' | 'data' | 'code' | 'security' | 'operations' | 'custom'
  riskLevel: 'low' | 'medium' | 'high'
  inputs: Array<{
    id: string
    label: string
    type: 'text' | 'textarea' | 'file' | 'folder' | 'select' | 'multi-select' | 'boolean' | 'number'
    required: boolean
    default?: unknown
    options?: string[]
  }>
  steps: RecipeStep[]
  artifacts: RecipeArtifact[]
  approvals: RecipeApprovalRule[]
  policies: RecipePolicy
}

export type RecipeStep = {
  id: string
  name: string
  type: 'skill' | 'tool' | 'subagent' | 'approval' | 'verify' | 'artifact' | 'hook'
  uses?: string
  with?: Record<string, unknown>
  dependsOn?: string[]
  onError?: 'stop' | 'continue' | 'ask_user'
}

export type RecipeArtifact = {
  id: string
  type: 'markdown' | 'docx' | 'pptx' | 'xlsx' | 'csv' | 'pdf' | 'json'
  pathTemplate: string
  required: boolean
}

export type RecipeApprovalRule = {
  beforeStep?: string
  tools?: string[]
  reason: string
  previewRequired: boolean
}

export type RecipePolicy = {
  requireTrustedRoot: boolean
  cloudContext: 'deny' | 'require_approval' | 'allow'
  allowShell: boolean
  allowWebFetch: boolean
  redactSecrets: boolean
  auditLevel: 'basic' | 'full'
}
```

## 8.5 Recipe 运行状态机

```txt
draft
  ↓
planning
  ↓
waiting_approval
  ↓
running
  ↓
verifying
  ↓
completed

异常路径：
failed / cancelled / partially_completed / rollback_required
```

对应运行记录：

```ts
export type RecipeRun = {
  runId: string
  recipeId: string
  recipeVersion: string
  status: 'draft' | 'planning' | 'waiting_approval' | 'running' | 'verifying' | 'completed' | 'failed' | 'cancelled'
  securityMode: 'local_strict' | 'enterprise_hybrid' | 'cloud_opt_in'
  providerId?: string
  modelId?: string
  workspaceRoot: string
  inputs: Record<string, unknown>
  steps: Array<{
    stepId: string
    status: string
    startedAt?: string
    finishedAt?: string
    toolCalls?: string[]
    artifactIds?: string[]
    error?: string
  }>
  artifacts: Array<{
    id: string
    type: string
    path: string
    hash?: string
  }>
  auditPath: string
  rollbackPath?: string
}
```

## 8.6 内置 Recipes 清单

### 8.6.1 `summary-report`

当前项目已有该 recipe 雏形，应升级为标准 Recipe：

```txt
目标：读取一个文件夹，生成 Markdown / DOCX / PPTX / PDF 报告。
Skills：summarize-folder、ppt-report
产物：summary.md、summary.docx、summary.pptx、summary.pdf
审批：写入所有产物前审批
安全：云模型模式下，本地文件摘要外发前审批
```

Recipe 示例：

```json
{
  "id": "summary-report",
  "name": "资料总结报告",
  "version": "2.0.0",
  "description": "读取本地资料并生成 Markdown、Word、PPT、PDF 报告。",
  "category": "office",
  "riskLevel": "medium",
  "inputs": [
    { "id": "sourceFolder", "label": "资料文件夹", "type": "folder", "required": true },
    { "id": "topic", "label": "报告主题", "type": "text", "required": true },
    { "id": "formats", "label": "输出格式", "type": "multi-select", "required": true, "default": ["md", "docx", "pptx", "pdf"] }
  ],
  "steps": [
    { "id": "scan", "name": "扫描资料", "type": "skill", "uses": "summarize-folder" },
    { "id": "plan", "name": "生成报告计划", "type": "approval", "dependsOn": ["scan"] },
    { "id": "write-md", "name": "生成 Markdown", "type": "artifact", "dependsOn": ["plan"] },
    { "id": "write-docx", "name": "生成 Word", "type": "artifact", "dependsOn": ["write-md"] },
    { "id": "write-pptx", "name": "生成 PPT", "type": "skill", "uses": "ppt-report", "dependsOn": ["write-md"] },
    { "id": "verify", "name": "读回自检", "type": "verify", "dependsOn": ["write-md", "write-docx", "write-pptx"] }
  ],
  "artifacts": [
    { "id": "md", "type": "markdown", "pathTemplate": ".AgentCowork/artifacts/{{runId}}/summary.md", "required": true },
    { "id": "docx", "type": "docx", "pathTemplate": ".AgentCowork/artifacts/{{runId}}/summary.docx", "required": false },
    { "id": "pptx", "type": "pptx", "pathTemplate": ".AgentCowork/artifacts/{{runId}}/summary.pptx", "required": false },
    { "id": "pdf", "type": "pdf", "pathTemplate": ".AgentCowork/artifacts/{{runId}}/summary.pdf", "required": false }
  ],
  "approvals": [
    { "beforeStep": "write-md", "reason": "即将写入报告产物", "previewRequired": true }
  ],
  "policies": {
    "requireTrustedRoot": true,
    "cloudContext": "require_approval",
    "allowShell": false,
    "allowWebFetch": false,
    "redactSecrets": true,
    "auditLevel": "full"
  }
}
```

### 8.6.2 `folder-organizer`

```txt
目标：分析文件夹，提出整理方案，审批后移动/重命名文件。
Skills：summarize-folder、privacy-check
工具：Glob、Read、Grep、Move preview、Move apply
产物：整理计划.md、移动映射表.csv、rollback.jsonl
风险：high，因为涉及移动/重命名
审批：必须逐项或批量审批 move plan
```

### 8.6.3 `contract-risk-table`

```txt
目标：批量读取合同，抽取关键字段和风险点，导出 Excel。
Skills：contract-extract、table-extract、privacy-check
产物：合同风险表.xlsx、风险摘要.md
审批：写入产物前审批；云模型上下文外发前审批
```

### 8.6.4 `meeting-minutes`

```txt
目标：读取会议纪要、录音转写或 Markdown，生成纪要和待办。
Skills：summarize-folder、table-extract
产物：会议纪要.md、待办事项.csv
审批：写入产物前审批
```

### 8.6.5 `codebase-audit`

```txt
目标：分析代码仓库结构、风险、测试覆盖和改造建议。
Skills：code-review、privacy-check、project-upgrade-plan
工具：Read、Glob、Grep，可选 Shell 只读命令
产物：代码审查报告.md、改造任务清单.md
审批：Shell 前审批；任何 Edit/Write 前审批
```

### 8.6.6 `project-upgrade-plan`

```txt
目标：读取 README、package scripts、目录结构、测试报告，生成项目升级路线图。
Skills：project-upgrade-plan、code-review
产物：升级计划.md、Backlog.csv、风险清单.md
审批：写入产物前审批
```

### 8.6.7 `local-privacy-report`

```txt
目标：扫描工作区中潜在敏感信息，生成本地隐私风险报告。
Skills：privacy-check
产物：隐私扫描报告.md
安全：禁止命中内容外发给云模型
```

### 8.6.8 `ppt-from-folder`

```txt
目标：基于本地资料生成演示文稿。
Skills：summarize-folder、ppt-report
产物：deck.pptx、speaker-notes.md
审批：写入产物前审批
```

## 8.7 Recipe API

```txt
GET  /api/recipes
GET  /api/recipes/:recipeId
POST /api/recipes/validate
POST /api/recipes/run
GET  /api/recipes/runs
GET  /api/recipes/runs/:runId
POST /api/recipes/runs/:runId/cancel
POST /api/recipes/runs/:runId/approve
```

## 8.8 Recipe 与 UI

任务入口不再只有聊天框，而是：

```txt
首页
  ├─ 直接描述任务
  ├─ 常用模板
  │   ├─ 整理文件夹
  │   ├─ 生成报告
  │   ├─ 提取表格
  │   ├─ 合同审查
  │   ├─ 代码审查
  │   └─ 生成 PPT
  └─ 最近任务
```

用户点击模板后看到表单，填完后生成计划，进入审批。

---

# 9. Hooks 设计

## 9.1 Hook 的定义

**Hook 是确定性生命周期拦截器**，在用户输入、模型请求、计划生成、工具调用、文件变更、产物生成、任务完成等关键节点运行，用于做安全检查、脱敏、审批升级、审计、通知和企业策略执行。

一句话：

> **Hook = 不由模型控制的确定性安全与自动化门禁。**

## 9.2 为什么需要 Hooks

Agent 系统最大的风险是：模型可能被 prompt injection 诱导，尝试读取不该读的文件、外发敏感信息、执行危险命令或绕过审批。

Hooks 的作用是把关键安全控制放回 Host：

```txt
模型说可以做 ≠ 系统允许做。
只有 Policy Engine + Hook Engine + Approval 都通过，工具才会执行。
```

## 9.3 Hook 事件列表

```ts
export type HookEventName =
  | 'UserPromptSubmit'
  | 'ContextPackCreated'
  | 'ModelRequestBefore'
  | 'ModelResponseAfter'
  | 'PlanCreated'
  | 'PermissionRequest'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'FileChanged'
  | 'ArtifactCreated'
  | 'RunCompleted'
  | 'RunFailed'
  | 'ProviderConfigChanged'
  | 'ConnectorChanged'
  | 'SkillLoaded'
  | 'RecipeStarted'
  | 'AuditFlush'
```

## 9.4 Hook 决策类型

```ts
export type HookDecision =
  | { decision: 'allow' }
  | { decision: 'block'; reason: string }
  | { decision: 'require_approval'; reason: string; approvalType?: string }
  | { decision: 'redact'; fields: string[]; reason?: string }
  | { decision: 'transform'; patch: Record<string, unknown>; reason?: string }
  | { decision: 'warn'; message: string }
```

多个 Hook 同时命中时的优先级：

```txt
block > require_approval > redact/transform > warn > allow
```

## 9.5 Hook Manifest Schema

```json
{
  "version": "1",
  "hooks": {
    "PreToolUse": [
      {
        "id": "block-dangerous-shell",
        "name": "阻止危险 Shell 命令",
        "enabled": true,
        "priority": 100,
        "matcher": {
          "tool": "Shell"
        },
        "rules": [
          {
            "if": "args.command matches /(rm -rf|format|del \\/s|curl .*\\|.*sh|powershell .*encodedcommand)/i",
            "then": "block",
            "reason": "命令包含高危破坏或远程脚本执行模式"
          }
        ],
        "timeoutMs": 1000
      }
    ]
  }
}
```

TypeScript：

```ts
export type HookManifest = {
  version: string
  hooks: Partial<Record<HookEventName, HookRule[]>>
}

export type HookRule = {
  id: string
  name: string
  enabled: boolean
  priority: number
  matcher?: {
    tool?: string | string[]
    providerId?: string | string[]
    skillId?: string | string[]
    recipeId?: string | string[]
    pathGlob?: string | string[]
    riskLevel?: string | string[]
  }
  rules: Array<{
    if: string
    then: 'allow' | 'block' | 'require_approval' | 'redact' | 'transform' | 'warn'
    reason?: string
    fields?: string[]
    patch?: Record<string, unknown>
  }>
  timeoutMs?: number
}
```

## 9.6 内置 Hooks 清单

### 9.6.1 `block-dangerous-shell`

事件：`PreToolUse`  
工具：`Shell`  
行为：阻止危险命令。

规则：

```txt
- 阻止 rm -rf /、format、del /s、rd /s 等破坏性命令。
- 阻止 curl | sh、wget | bash、powershell encodedcommand。
- 阻止修改系统目录、用户 home 根目录、SSH 目录、浏览器凭证目录。
- 阻止未审批的网络探测、端口扫描、凭证导出。
```

### 9.6.2 `require-approval-for-write`

事件：`PreToolUse`  
工具：`Write / Edit / Move / Delete`  
行为：所有写入型操作必须审批。

### 9.6.3 `trusted-root-enforcer`

事件：`PreToolUse`  
工具：所有文件工具  
行为：所有路径必须解析后仍在 trusted root 内。

### 9.6.4 `secret-redaction-before-model`

事件：`ModelRequestBefore`  
行为：发送给模型前做密钥脱敏。

匹配内容：

```txt
.env
API Key
Authorization: Bearer
SSH private key
GitHub token
数据库连接串
云厂商 AK/SK
```

### 9.6.5 `cloud-context-approval`

事件：`ModelRequestBefore`  
行为：如果当前 provider 是公网云模型，且请求包含本地文件片段，则要求用户审批。

### 9.6.6 `block-sensitive-egress`

事件：`ModelRequestBefore / WebFetch / MCP call`  
行为：如果上下文包含高敏内容，直接阻止外发。

高敏内容包括：

```txt
- .env / .pem / .key / id_rsa
- 密码、token、私钥
- 客户身份证、手机号、银行卡
- 源代码仓库凭证
- 企业内网地址和登录 cookie
```

### 9.6.7 `artifact-readback-verify`

事件：`ArtifactCreated`  
行为：产物生成后读回校验。

```txt
- 检查文件存在。
- 检查大小非零。
- 检查 MIME/扩展名匹配。
- 检查 Markdown/PPT/DOCX/PDF writer 是否写入失败。
- 写入 artifact hash。
```

### 9.6.8 `audit-run-summary`

事件：`RunCompleted / RunFailed`  
行为：生成 run 摘要。

记录：

```txt
- 使用的 recipe/skill/provider/model
- 访问过的文件路径摘要
- 工具调用列表
- 审批记录
- 产物路径
- 错误和回滚信息
```

### 9.6.9 `provider-config-guard`

事件：`ProviderConfigChanged`  
行为：阻止不安全模型配置。

规则：

```txt
- local_strict 模式禁止启用公网 provider。
- baseURL 不能指向 link-local、内网元数据服务或不可信 scheme。
- API Key 不允许写入 URL query。
- 变更 provider 后必须重新 capability probe。
```

### 9.6.10 `connector-risk-guard`

事件：`ConnectorChanged / PreToolUse`  
行为：MCP 连接器风险控制。

规则：

```txt
- 新连接器默认 disabled，需要用户启用。
- 高风险 MCP tool 不允许子代理直接调用。
- OAuth scope 必须 allowlist + 单次审批。
- 断开连接器后撤销工具 registry。
```

## 9.7 Hooks 配置文件示例

```json
{
  "version": "1",
  "hooks": {
    "ModelRequestBefore": [
      {
        "id": "cloud-context-approval",
        "name": "云模型上下文外发审批",
        "enabled": true,
        "priority": 100,
        "matcher": { "providerId": ["deepseek", "moonshot-kimi", "qwen-dashscope-cn", "zai-glm", "volcengine-ark"] },
        "rules": [
          {
            "if": "request.containsLocalFileContext == true && securityMode != 'cloud_opt_in'",
            "then": "require_approval",
            "reason": "请求包含本地文件上下文，发送给公网模型前需要用户确认"
          }
        ],
        "timeoutMs": 1000
      },
      {
        "id": "secret-redaction-before-model",
        "name": "模型请求前脱敏",
        "enabled": true,
        "priority": 90,
        "rules": [
          {
            "if": "request.text matches /(sk-[A-Za-z0-9]|BEGIN .*PRIVATE KEY|Authorization: Bearer)/i",
            "then": "redact",
            "fields": ["messages", "contextPack"],
            "reason": "检测到疑似密钥或私钥"
          }
        ],
        "timeoutMs": 1000
      }
    ],
    "PreToolUse": [
      {
        "id": "require-approval-for-write",
        "name": "写操作审批",
        "enabled": true,
        "priority": 100,
        "matcher": { "tool": ["Write", "Edit", "Move", "Delete"] },
        "rules": [
          {
            "if": "tool.riskLevel in ['medium', 'high']",
            "then": "require_approval",
            "reason": "写入、编辑、移动、删除本地文件前必须审批"
          }
        ]
      },
      {
        "id": "block-dangerous-shell",
        "name": "危险 Shell 阻断",
        "enabled": true,
        "priority": 110,
        "matcher": { "tool": "Shell" },
        "rules": [
          {
            "if": "args.command matches /(rm -rf|format|curl .*\\|.*sh|wget .*\\|.*bash|encodedcommand)/i",
            "then": "block",
            "reason": "命令包含高危模式"
          }
        ]
      }
    ],
    "ArtifactCreated": [
      {
        "id": "artifact-readback-verify",
        "name": "产物读回校验",
        "enabled": true,
        "priority": 50,
        "rules": [
          {
            "if": "artifact.size == 0 || artifact.path outside trustedRoot",
            "then": "block",
            "reason": "产物为空或路径越界"
          }
        ]
      }
    ]
  }
}
```

## 9.8 Hook Engine 设计原则

```txt
- Hook 必须确定性执行，不依赖模型判断。
- Hook 默认超时 1 秒，超时按 fail-closed 或策略配置处理。
- 安全 Hook 不允许被 workspace 覆盖关闭。
- 企业策略 Hook 优先级高于用户 Hook。
- Hook 执行结果必须写入 audit。
- Hook 规则语言要限制能力，不能任意执行 JS。
- 高级插件 Hook 如需执行代码，必须运行在沙箱中。
```

## 9.9 Hook API

```txt
GET  /api/hooks
POST /api/hooks/validate
POST /api/hooks/reload
POST /api/hooks/test
GET  /api/hooks/events/:runId
```

---

# 10. Skills / Recipes / Hooks 协同流程

## 10.1 用户输入到执行的完整链路

```txt
用户输入任务
  ↓
UserPromptSubmit Hook
  ↓
Task Classifier 判断是否匹配 Recipe
  ↓
RecipeRegistry 返回候选模板
  ↓
SkillRegistry 返回候选能力
  ↓
ContextPackCreated Hook 做路径和敏感信息检查
  ↓
ModelRouter 选择模型
  ↓
ModelRequestBefore Hook 做本地/云边界检查和脱敏
  ↓
生成 Plan
  ↓
PlanCreated Hook 检查计划是否越权
  ↓
用户审批
  ↓
PreToolUse Hook 检查每次工具调用
  ↓
Tool 执行
  ↓
PostToolUse Hook 检查结果
  ↓
ArtifactCreated Hook 读回校验
  ↓
RunCompleted Hook 生成审计摘要
```

## 10.2 示例：用户要求“把这个文件夹整理成报告和 PPT”

```txt
1. Task Classifier 匹配 recipe：summary-report + ppt-from-folder。
2. Recipe 调用 skill：summarize-folder 扫描资料。
3. ContextPack 只读取 trusted root 内允许扩展名。
4. ModelRouter 根据安全模式选择本地模型或云模型。
5. 如使用云模型，Hook 要求用户确认摘要外发。
6. Plan Mode 生成计划：读取文件、写 summary.md、写 deck.pptx。
7. 用户审批写入计划。
8. Tool 执行写入。
9. Artifact Hook 读回校验。
10. Run Audit 记录 recipe、skill、模型、工具、产物、审批。
```

## 10.3 示例：用户要求“帮我重构代码”

```txt
1. 匹配 recipe：codebase-audit 或 project-upgrade-plan。
2. skill：code-review 只读分析。
3. 如果需要 Shell，PreToolUse Hook 要求审批。
4. 如果需要 Edit，必须先生成 patch preview。
5. 用户审批后才应用变更。
6. PostToolUse 读回变更文件。
7. Artifact 生成改造报告和 rollback。
```

---

# 11. 前端产品设计

## 11.1 信息架构

```txt
Agent Cowork
  ├─ 首页 / 任务入口
  ├─ 任务中心
  ├─ 产物
  ├─ 工作区
  ├─ Skills
  ├─ Recipes
  ├─ Hooks
  ├─ 模型设置
  ├─ 连接器
  ├─ 审批与审计
  └─ 安全中心
```

## 11.2 任务中心字段

```ts
type CoworkRunCard = {
  runId: string
  title: string
  status: string
  recipeId?: string
  skillIds: string[]
  providerId?: string
  modelId?: string
  securityMode: string
  riskLevel: 'low' | 'medium' | 'high'
  artifactCount: number
  approvalState?: 'not_required' | 'waiting' | 'approved' | 'rejected'
  startedAt: string
  durationMs?: number
}
```

UI 必须显示四件事：

```txt
- 正在读什么
- 准备改什么
- 等待你批什么
- 最后生成了什么
```

## 11.3 Skills 页面

功能：

```txt
- 查看内置 skill
- 查看 workspace skill
- 启用/禁用 skill
- 验证 skill 文件
- 查看 allowedTools、riskLevel、artifact types
- 查看最近使用该 skill 的 runs
```

## 11.4 Recipes 页面

功能：

```txt
- 模板市场 / 内置模板
- 收藏常用 recipe
- 运行 recipe
- 查看输入表单
- 查看流程图
- 查看审批点
- 查看产物定义
```

## 11.5 Hooks 页面

默认面向高级用户或企业管理员：

```txt
- 查看内置安全 Hook
- 查看企业策略 Hook
- 查看 workspace Hook
- 测试 Hook 规则
- 查看某个 run 触发过哪些 Hook
- 禁用非安全 Hook
```

安全 Hook 不提供普通用户关闭按钮。

---

# 12. 后端改造计划

## 12.1 新增目录建议

```txt
apps/host/src/models/
  model-router.ts
  provider-registry.ts
  provider-presets-cn.ts
  openai-compatible-adapter.ts
  anthropic-compatible-adapter.ts
  local-openai-adapter.ts
  capability-probe.ts
  secret-store.ts

apps/host/src/extensions/
  skills/
    skill-registry.ts
    skill-loader.ts
    skill-validator.ts
    skill-matcher.ts
  recipes/
    recipe-registry.ts
    recipe-loader.ts
    recipe-validator.ts
    recipe-runner.ts
  hooks/
    hook-engine.ts
    hook-loader.ts
    hook-validator.ts
    builtin-hooks.ts
    rule-evaluator.ts

apps/host/src/policies/
  security-mode.ts
  policy-engine.ts
  egress-policy.ts
  tool-risk.ts

apps/host/src/onboarding/
  onboarding-state.ts
  demo-workspace.ts
  first-run.ts
```

## 12.2 数据存储表

SQLite / PostgreSQL 可增加：

```sql
CREATE TABLE model_providers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  base_url TEXT NOT NULL,
  default_model TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  allow_cloud_context INTEGER NOT NULL,
  capability_report_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE extension_registry (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL, -- skill | recipe | hook
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT NOT NULL, -- builtin | user | workspace | enterprise
  path TEXT,
  hash TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE run_extensions (
  run_id TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  extension_type TEXT NOT NULL,
  version TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (run_id, extension_id, extension_type)
);

CREATE TABLE hook_events (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  event_name TEXT NOT NULL,
  hook_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
```

## 12.3 Policy Engine 接口

```ts
export type PolicyDecision =
  | { decision: 'allow' }
  | { decision: 'block'; reason: string }
  | { decision: 'require_approval'; reason: string; approvalPayload: unknown }
  | { decision: 'redact'; fields: string[]; reason: string }

export type PolicyContext = {
  securityMode: 'local_strict' | 'enterprise_hybrid' | 'cloud_opt_in'
  provider?: ModelProviderConfig
  tool?: ToolCall
  skillIds?: string[]
  recipeId?: string
  workspaceRoot: string
  containsLocalFileContext: boolean
  containsSensitiveContext: boolean
  userRole?: string
}
```

### 核心规则

```ts
function evaluateModelPolicy(ctx: PolicyContext): PolicyDecision {
  if (ctx.securityMode === 'local_strict' && ctx.provider?.region !== 'local' && ctx.provider?.region !== 'enterprise') {
    return { decision: 'block', reason: '本地严格模式禁止调用公网模型' }
  }

  if (ctx.provider?.allowCloudContext && ctx.containsSensitiveContext) {
    return {
      decision: 'require_approval',
      reason: '请求包含本地敏感上下文，发送给云模型前需要确认',
      approvalPayload: { providerId: ctx.provider.id }
    }
  }

  return { decision: 'allow' }
}
```

---

# 13. 安全与保密要求

## 13.1 数据分级

| 等级 | 示例 | 默认处理 |
|---|---|---|
| Public | 示例文件、公开资料 | 可使用云模型 |
| Internal | 内部文档、普通项目资料 | 云模型前审批 |
| Confidential | 合同、客户资料、代码、财务 | 默认本地处理 |
| Secret | 密钥、私钥、凭证、身份信息 | 禁止外发，必要时仅显示脱敏摘要 |

## 13.2 外发控制

```txt
- local_strict：任何公网模型请求都 block。
- enterprise_hybrid：provider 必须在 allowlist；本地上下文外发 require approval。
- cloud_opt_in：允许云模型，但敏感信息仍需 redaction 和高敏阻断。
```

## 13.3 工具风险等级

| 工具 | 风险 | 默认策略 |
|---|---|---|
| Read / Glob / Grep | low | trusted root 内允许 |
| Write / Edit | medium | 计划 + 审批 |
| Move / Rename | high | preview + 审批 + rollback |
| Delete | high | 默认禁用或强审批 |
| Shell | high | 默认禁用；只读命令可审批开启 |
| WebFetch | medium/high | SSRF 守卫 + allowlist + 外发审批 |
| MCP Tool | 视 manifest | 默认最小权限 |

## 13.4 审计要求

每次 run 必须记录：

```txt
- runId、开始/结束时间、状态
- 用户输入摘要
- securityMode
- providerId、modelId，不记录 API Key
- recipeId、recipeVersion、recipeHash
- skillIds、skillVersions、skillHashes
- hook 触发记录
- 工具调用记录
- 审批记录
- 产物路径和 hash
- rollback 路径
```

## 13.5 本地与云模型提示语

当用户启用云模型时，UI 必须展示：

```txt
你正在使用公网模型。为了生成结果，Agent Cowork 可能会把你审批过的任务描述、文件摘要或上下文片段发送给模型服务商。原始文件仍保存在本地，但被发送的片段会离开本机。请勿在未确认前处理密钥、合同、客户资料、源代码等高敏信息。
```

---

# 14. 开发里程碑

## Phase 0：基础抽象

目标：把 Kimi 专用层替换为通用模型层。

任务：

```txt
- 新增 ModelRouter
- 新增 ProviderRegistry
- 新增 OpenAICompatibleAdapter
- 新增 provider-presets-cn
- 新增 SecretStore 统一密钥读取
- 新增 capability probe
- 新增 /api/llm/chat、/api/llm/plan
- 兼容 /api/agent-engine/chat、/api/agent-engine/plan
```

验收：

```txt
- Kimi 旧功能不回退。
- 至少 3 个国产 provider 可配置并通过最小 chat 测试。
- local_strict 下公网模型被阻止。
- API Key 不出现在前端响应、run、audit、artifact。
```

## Phase 1：新手向导

任务：

```txt
- 新增 OnboardingWizard
- 新增安全模式选择
- 新增模型配置卡片
- 新增工作区选择
- 新增示例工作区生成器
- 新增第一个 demo recipe
```

验收：

```txt
- 新用户不看 README 也能跑通第一个任务。
- 不填 API Key 可进入本地演示。
- 选择云模型会看到出本地提示。
- 示例任务展示计划、审批、执行、产物、审计。
```

## Phase 2：Skills

任务：

```txt
- 新增 SkillRegistry
- 新增 SkillLoader
- 新增 SkillValidator
- 新增 SkillMatcher
- 内置 8 个 skills
- UI 增加 Skills 页面
```

验收：

```txt
- skill front matter 校验失败时有明确错误。
- run 中记录 skillId/version/hash。
- skill 不能绕过 tool policy。
- workspace skill 可热重载。
```

## Phase 3：Recipes

任务：

```txt
- 新增 RecipeRegistry
- 新增 RecipeRunner
- 新增 Recipe 表单渲染
- 标准化 summary-report
- 内置 folder-organizer、contract-risk-table、codebase-audit、ppt-from-folder
```

验收：

```txt
- 用户可以从模板启动任务。
- Recipe 能生成计划和审批点。
- 产物进入统一 artifacts 面板。
- recipe run 可取消、失败、重试。
```

## Phase 4：Hooks

任务：

```txt
- 新增 HookEngine
- 新增 HookValidator
- 新增 RuleEvaluator
- 内置 10 个安全 Hook
- UI 增加 Hooks 页面
- run 记录 hook events
```

验收：

```txt
- 危险 Shell 被 block。
- 写操作自动 require approval。
- 云模型上下文外发触发审批。
- 密钥在 ModelRequestBefore 被脱敏。
- Hook 超时不导致越权执行。
```

## Phase 5：企业策略与插件化

任务：

```txt
- 企业级 provider allowlist / denylist
- 禁止 workspace 覆盖安全 hook
- 插件 manifest
- 插件签名和 hash 校验
- 审计导出
```

验收：

```txt
- 管理员可强制 local_strict。
- 管理员可禁止某些 provider。
- 插件变更可审计。
- 审计报告可导出。
```

---

# 15. 最小可交付版本 MVP 范围

建议第一版不要贪多，MVP 只做这些：

```txt
1. ModelRouter + 10 个国产 provider preset + local provider。
2. OnboardingWizard 7 步。
3. Skills：summarize-folder、privacy-check、code-review。
4. Recipes：summary-report、folder-organizer、codebase-audit。
5. Hooks：cloud-context-approval、secret-redaction、require-approval-for-write、block-dangerous-shell、artifact-readback-verify。
6. 任务中心显示 recipe、skill、provider、securityMode、审批、产物。
```

不建议 MVP 第一版做：

```txt
- 插件市场
- 任意 JS Hook
- 复杂多租户后台
- 大规模团队权限
- 自动训练/微调
- 无审批的全自动文件整理
```

---

# 16. 验收测试清单

## 16.1 模型配置测试

```txt
- DeepSeek / Kimi / 通义 / 本地 Ollama 至少各跑一次 chat。
- 错误 API Key 显示明确错误，不泄漏 key。
- local_strict 下云 provider 被 block。
- cloud_opt_in 下云 provider 可用，但敏感内容仍脱敏。
- capability probe 能显示 streaming/json/tool/vision/reasoning 状态。
```

## 16.2 新手向导测试

```txt
- 首次启动自动出现。
- 跳过后可在设置中重新打开。
- 不选真实工作区也能用示例工作区完成任务。
- 审批教学中 diff preview 正确。
- 完成后进入任务中心。
```

## 16.3 Skills 测试

```txt
- 无效 YAML front matter 被拒绝。
- allowedTools 不存在时报错。
- skill 输出路径越界时报错。
- workspace skill 覆盖 builtin 时记录来源。
- run audit 记录 skill hash。
```

## 16.4 Recipes 测试

```txt
- recipe schema 校验。
- summary-report 生成 md/docx/pptx/pdf。
- folder-organizer 只在审批后移动文件。
- codebase-audit 默认只读，不自动改代码。
- recipe 失败时保留部分产物和错误原因。
```

## 16.5 Hooks 测试

```txt
- Shell: rm -rf 被阻止。
- Shell: npm test 需要审批。
- Write: 未审批不得执行。
- ModelRequestBefore: .env 内容被脱敏。
- ModelRequestBefore: 云模型外发本地上下文触发审批。
- ArtifactCreated: 0 字节产物被标记失败。
- ProviderConfigChanged: baseURL 指向 metadata IP 被阻止。
```

## 16.6 审计测试

```txt
- 每个 run 有 audit jsonl。
- audit 中不出现 API Key。
- audit 中记录 provider/model/skill/recipe/hook。
- rollback 文件存在。
- 任务中心可打开 run 详情。
```

---

# 17. 推荐文件清单

落地时建议新增或修改：

```txt
docs/Agent-Cowork-2.0-国产模型-Skills-Recipes-Hooks方案.md

apps/host/src/models/model-router.ts
apps/host/src/models/provider-registry.ts
apps/host/src/models/provider-presets-cn.ts
apps/host/src/models/openai-compatible-adapter.ts
apps/host/src/models/capability-probe.ts

apps/host/src/extensions/skills/skill-registry.ts
apps/host/src/extensions/skills/skill-loader.ts
apps/host/src/extensions/skills/skill-validator.ts
apps/host/src/extensions/skills/skill-matcher.ts

apps/host/src/extensions/recipes/recipe-registry.ts
apps/host/src/extensions/recipes/recipe-runner.ts
apps/host/src/extensions/recipes/recipe-validator.ts

apps/host/src/extensions/hooks/hook-engine.ts
apps/host/src/extensions/hooks/hook-loader.ts
apps/host/src/extensions/hooks/hook-validator.ts
apps/host/src/extensions/hooks/rule-evaluator.ts

apps/web/src/components/onboarding/OnboardingWizard.tsx
apps/web/src/components/models/ProviderCard.tsx
apps/web/src/components/skills/SkillsPage.tsx
apps/web/src/components/recipes/RecipesPage.tsx
apps/web/src/components/hooks/HooksPage.tsx
apps/web/src/components/tasks/TaskCenter.tsx
```

---

# 18. 文档内置示例文件

## 18.1 示例 Skill：`privacy-check.skill.md`

```md
---
id: privacy-check
name: 本地隐私检查
version: 1.0.0
category: security
riskLevel: low
allowedTools:
  - Read
  - Glob
  - Grep
requiresApproval: []
contextPack:
  maxFiles: 200
  maxBytesPerFile: 50000
  includeExtensions: [.env, .txt, .md, .json, .yaml, .yml, .ts, .js, .py, .go]
  excludeGlobs:
    - "**/node_modules/**"
    - "**/.git/**"
artifacts:
  - type: markdown
    defaultPath: .AgentCowork/artifacts/隐私检查报告.md
policies:
  cloudContext: deny
  redactSecrets: true
  requireTrustedRoot: true
  allowShell: false
  allowWebFetch: false
---

# Instructions

你是本地隐私检查助手。请扫描用户选择的 trusted root，识别潜在敏感信息。

只输出脱敏摘要，不输出完整密钥、私钥、token、密码或身份证件号。

报告结构：
1. 扫描范围
2. 命中类型统计
3. 风险文件路径
4. 脱敏示例
5. 处理建议
```

## 18.2 示例 Recipe：`codebase-audit.recipe.json`

```json
{
  "id": "codebase-audit",
  "name": "代码项目审查",
  "version": "1.0.0",
  "description": "只读分析代码项目，生成结构、风险、测试和改造建议。",
  "category": "code",
  "riskLevel": "medium",
  "inputs": [
    { "id": "workspace", "label": "代码工作区", "type": "folder", "required": true },
    { "id": "focus", "label": "关注点", "type": "textarea", "required": false }
  ],
  "steps": [
    { "id": "privacy", "name": "隐私检查", "type": "skill", "uses": "privacy-check" },
    { "id": "review", "name": "代码审查", "type": "skill", "uses": "code-review", "dependsOn": ["privacy"] },
    { "id": "write-report", "name": "写入审查报告", "type": "artifact", "dependsOn": ["review"] },
    { "id": "verify", "name": "读回校验", "type": "verify", "dependsOn": ["write-report"] }
  ],
  "artifacts": [
    { "id": "report", "type": "markdown", "pathTemplate": ".AgentCowork/artifacts/{{runId}}/代码审查报告.md", "required": true }
  ],
  "approvals": [
    { "beforeStep": "write-report", "reason": "即将写入代码审查报告", "previewRequired": true }
  ],
  "policies": {
    "requireTrustedRoot": true,
    "cloudContext": "require_approval",
    "allowShell": false,
    "allowWebFetch": false,
    "redactSecrets": true,
    "auditLevel": "full"
  }
}
```

## 18.3 示例 Hooks：`hooks.json`

```json
{
  "version": "1",
  "hooks": {
    "PreToolUse": [
      {
        "id": "trusted-root-enforcer",
        "name": "Trusted Root 路径保护",
        "enabled": true,
        "priority": 200,
        "rules": [
          {
            "if": "tool.pathResolvedOutsideTrustedRoot == true",
            "then": "block",
            "reason": "工具访问路径超出 trusted root"
          }
        ]
      },
      {
        "id": "require-approval-for-write",
        "name": "写入操作审批",
        "enabled": true,
        "priority": 150,
        "matcher": { "tool": ["Write", "Edit", "Move", "Delete"] },
        "rules": [
          {
            "if": "true",
            "then": "require_approval",
            "reason": "写入、编辑、移动或删除文件前必须用户审批"
          }
        ]
      },
      {
        "id": "block-dangerous-shell",
        "name": "阻止危险 Shell",
        "enabled": true,
        "priority": 180,
        "matcher": { "tool": "Shell" },
        "rules": [
          {
            "if": "args.command matches /(rm -rf|format|del \\/s|rd \\/s|curl .*\\|.*sh|wget .*\\|.*bash|encodedcommand)/i",
            "then": "block",
            "reason": "命令包含危险模式"
          }
        ]
      }
    ],
    "ModelRequestBefore": [
      {
        "id": "local-strict-cloud-block",
        "name": "本地严格模式阻止公网模型",
        "enabled": true,
        "priority": 200,
        "rules": [
          {
            "if": "securityMode == 'local_strict' && provider.region == 'cn'",
            "then": "block",
            "reason": "本地严格模式禁止调用公网模型"
          }
        ]
      },
      {
        "id": "cloud-context-approval",
        "name": "本地上下文外发审批",
        "enabled": true,
        "priority": 150,
        "rules": [
          {
            "if": "request.containsLocalFileContext == true && provider.region != 'local'",
            "then": "require_approval",
            "reason": "请求包含本地文件上下文，发送给云模型前需要确认"
          }
        ]
      },
      {
        "id": "secret-redaction-before-model",
        "name": "模型请求前敏感信息脱敏",
        "enabled": true,
        "priority": 140,
        "rules": [
          {
            "if": "request.text matches /(BEGIN .*PRIVATE KEY|Authorization: Bearer|sk-[A-Za-z0-9]|AKIA[0-9A-Z]{16})/i",
            "then": "redact",
            "fields": ["messages", "contextPack"],
            "reason": "检测到疑似密钥、私钥或 token"
          }
        ]
      }
    ],
    "ArtifactCreated": [
      {
        "id": "artifact-readback-verify",
        "name": "产物读回校验",
        "enabled": true,
        "priority": 100,
        "rules": [
          {
            "if": "artifact.size <= 0",
            "then": "block",
            "reason": "产物文件为空"
          }
        ]
      }
    ]
  }
}
```

---

# 19. 关键产品决策

建议直接确认以下决策：

```txt
1. 默认安全模式：local_strict。
2. 公网模型：默认可配置，但发送本地上下文前必须明确提示。
3. 模型策略：Kimi 不再是核心抽象，ModelRouter 才是核心抽象。
4. Skills：内置 + workspace 两级，企业版增加 org 级。
5. Recipes：作为首页任务模板核心，不只是隐藏配置。
6. Hooks：安全 Hook 不允许普通用户关闭。
7. Shell：默认禁用，高级用户或 recipe 明确声明后审批使用。
8. Delete：默认不开放，或仅企业策略允许。
9. MCP：连接器默认最小权限，高风险工具必须审批。
10. 审计：默认本地 JSONL，企业版可导出和集中汇总。
```

---

# 20. 参考来源与备注

本方案基于当前 Agent Cowork README 中列出的能力基线，并结合 2026-07-02 查阅的各模型厂商官方文档整理 provider presets。由于模型平台接口、模型名、地域域名、套餐和能力会频繁更新，产品实现时必须保留“自定义 OpenAI 兼容接口”和“能力自动检测”，不要把模型名写死。

建议在仓库中将本文放到：

```txt
docs/Agent-Cowork-2.0-国产模型-Skills-Recipes-Hooks方案.md
```
