# Agent Cowork 2.5：高性价比多 Agent 编排实施计划

> 版本：v2.5
> 目标读者：Agent Cowork 项目开发者
> 关键词：多 Agent 编排、低成本实现、本地优先、办公协作、Supervisor、Router、Map-Reduce、事件流、预算控制、可审计

---

## 0. 一句话结论

当前 Agent Cowork 不建议直接引入 LangGraph、CrewAI、AutoGen、Semantic Kernel / Microsoft Agent Framework、LlamaIndex Workflows、OpenAI Agents SDK 等完整框架重写，而应该采用 **“借鉴成熟框架设计思想 + 保留现有 Node/TypeScript Host + 增加一个薄编排层 Orchestrator Runtime”** 的路线。

最划算的实现路径是：

```txt
先做：确定性 Workflow + Supervisor 调度 + 子 Agent 并发 + 合成器 + 校验器
后做：动态 handoff、复杂图状态机、跨设备/跨进程 worker、企业级可视化编排
暂缓：自由群聊式 swarm、无限自主递归、全量导入 Python agent 框架
```

产品上，对普通白领用户不要展示“多 Agent 技术概念”，而是展示：

```txt
AI 小队正在协作：
- 资料整理员：读取并归纳文件
- 表格助手：检查数据和公式
- 报告写手：生成正式文本
- 安全检查员：检查是否越权、是否泄密
- 总控助手：合并结果并让你确认
```

---

## 1. 当前项目基础判断

根据当前 README，Agent Cowork 已经有以下可复用基础：

- Agentic tool-calling loop：模型能自主调用 `Read / Write / Edit / Glob / Grep / Shell / WebFetch` 等工具。
- Plan Mode：先生成计划，用户批准后才执行写入。
- MCP 协议栈：已有 stdio transport、JSON-RPC、MCP client、命名空间工具注册。
- 稳定性基础：CircuitBreaker、Token Bucket、ApprovalRegistry TTL。
- 存储基础：SQLite / PostgreSQL，PostgreSQL 已支持跨实例 approval。
- 安全基础：trusted root jail、敏感段黑名单、symlink 解析、redaction、JWT、SSRF 防护、Host 白名单、`shell:false`。
- 运行记录：`GET /api/runs`、`.AgentCowork/runs/*.json`、audit、artifact、rollback。
- 子 Agent 雏形：README 已出现 `/api/subagent/run`、`/api/subagent/parallel` 和 `AgentParallel` 工具，并说明子任务有上下文预算、步数限制和 child lifecycle events。

因此，多 Agent 编排不应该从零开始，而应把现有子任务能力升级为：

```txt
Agent Registry
  ↓
Orchestrator Runtime
  ↓
Workflow / Recipe Graph
  ↓
Subagent Runner / AgentParallel
  ↓
Tool Registry / MCP / File Ops / Approval / Audit
```

---

## 2. 参考热门 Agent 框架后提炼的核心经验

### 2.1 LangGraph / LangChain Multi-Agent

可参考点：

- 多 Agent 不是只有一种形态，常见模式包括 `Subagents`、`Handoffs`、`Skills`、`Router`、`Custom Workflow`。
- 多 Agent 特别适用于：单 Agent 工具太多导致选择错误、任务需要专业上下文、任务有严格顺序约束。
- 中心问题不是“Agent 越多越好”，而是 **context engineering**：每个 Agent 应该看见什么、不能看见什么、拿到哪些工具。
- `Subagents` 由主 Agent 调度子 Agent，控制最集中，适合 Agent Cowork 的本地安全策略。
- `Router` 把任务分类给一个或多个专家，适合办公模板。
- `Skills` 比多 Agent 更便宜，简单任务优先用 Skills，不必每次拉起多个模型调用。

Agent Cowork 应吸收的设计：

```txt
优先采用：Supervisor + Subagents + Router + Skills
谨慎采用：Handoffs
暂缓采用：完全自由的去中心化 swarm
```

### 2.2 CrewAI

可参考点：

- CrewAI 的抽象是 `Agent / Task / Crew / Flow`。
- `Crew` 适合角色分工：研究员、写手、审阅员、分析师。
- `Flow` 适合确定性业务流程：开始、监听、路由、状态持久化、恢复。
- 生产场景强调 guardrails、memory、knowledge、observability。

Agent Cowork 应吸收的设计：

```txt
Agent = 可复用岗位角色
Task = 一次明确的子任务
Crew = 某个 Recipe 需要的一组角色
Flow = 可审计、可恢复、可审批的业务流程
```

不要照搬 CrewAI 的 Python 运行时；只借鉴它的角色与任务建模。

### 2.3 AutoGen / Microsoft Agent Framework / Semantic Kernel

可参考点：

- AutoGen 早期推动了 GroupChat、事件驱动 Agent Runtime 等多 Agent 思路，但官方 GitHub 当前提示 AutoGen 进入 maintenance mode，新项目建议迁移到 Microsoft Agent Framework。
- Microsoft Agent Framework 强调：能用函数解决就不要用 Agent；开放式任务用 Agent，明确步骤任务用 Workflow。
- 它把 AutoGen 的多 Agent 思路与 Semantic Kernel 的企业能力结合起来，强调 session state、type safety、middleware、telemetry、graph-based workflows、human-in-the-loop、checkpoint/resume。

Agent Cowork 应吸收的设计：

```txt
1. 明确流程优先 Workflow，不要所有任务都靠模型自由聊天。
2. 所有子 Agent 输入输出必须 typed schema。
3. 必须有 checkpoint / resume / cancel。
4. 必须有 human-in-the-loop gate。
5. 编排事件必须能审计和回放。
```

### 2.4 LlamaIndex Workflows

可参考点：

- Workflow 是 event-driven、step-based 的执行模型。
- 一个 step 接收 event，执行工作，然后返回下一个 event。
- 分支是普通条件判断，循环是返回给前面的事件，并发是发出事件列表。
- 这种模型比复杂 DAG 对开发者更自然，尤其适合长任务、可恢复任务和混合确定性逻辑。

Agent Cowork 应吸收的设计：

```txt
Orchestrator 内部事件流：
TaskStartedEvent
  → ContextPackedEvent
  → AgentTaskStartedEvent
  → AgentTaskCompletedEvent
  → SynthesisStartedEvent
  → VerificationCompletedEvent
  → ApprovalRequestedEvent
  → ArtifactCreatedEvent
  → RunCompletedEvent
```

### 2.5 OpenAI Agents SDK / OpenAI Agents SDK TypeScript

可参考点：

- 核心原语少：Agent loop、Tools、Agents as tools、Handoffs、Guardrails、Sessions、Human-in-the-loop、Tracing。
- TypeScript 版本也强调 agent loop、sandbox execution、Zod schema、MCP tools、sessions、guardrails、tracing。
- 对 Agent Cowork 来说，最值得借鉴的是 **“少量强原语，不引入陡峭学习曲线”**。

Agent Cowork 应吸收的设计：

```txt
Agent Cowork 原语只保留 8 个：
AgentDefinition
ToolBinding
AgentTask
Handoff
Guardrail
SessionState
TraceEvent
HumanGate
```

### 2.6 PydanticAI

可参考点：

- 多 Agent 可以分为几个复杂度层级：单 Agent、Agent delegation、程序式 handoff、graph-based control flow、deep agents。
- 不同 Agent 可用不同模型，但必须用 usage limits 控制请求次数、tokens、工具调用次数，避免 runaway loops。

Agent Cowork 应吸收的设计：

```txt
复杂度阶梯：
Level 0: 单 Agent + Skills
Level 1: Agent delegation，主控调用一个专家
Level 2: Programmatic handoff，由代码决定下一个 Agent
Level 3: Graph workflow，多 Agent 节点和条件边
Level 4: Deep Agent，具备计划、文件操作、任务委派和沙箱执行

v2.5 只做到 Level 2.5，避免一开始进入不可控复杂度。
```

---

## 3. 不建议直接引入完整框架的原因

你的产品护城河是本地、安全、可控、低门槛，而不是追逐框架复杂度。直接导入完整多 Agent 框架会带来以下问题：

| 方案 | 短期收益 | 长期问题 | 建议 |
|---|---:|---|---|
| 直接引入 LangGraph Python | 能快速实验复杂图 | Node/TS 主工程割裂、部署重、状态和安全边界重复 | 不建议主路径 |
| 直接引入 CrewAI | 角色/任务建模成熟 | Python 依赖、生态外接、和现有 MCP/审批重复 | 只借鉴抽象 |
| 继续用 AutoGen | GroupChat 资料多 | 官方维护状态不适合作为新核心 | 不建议 |
| 直接上 Microsoft Agent Framework | 企业级抽象强 | 当前项目主栈是 Node/TS，本地办公产品不必绑定微软栈 | 只借鉴 workflow 思路 |
| 直接引入 OpenAI Agents SDK TS | TS 适配度好 | 可能弱化国产模型/本地模型适配，且与现有 loop 重叠 | 可作为参考或可选 adapter |
| 自研薄编排层 | 最贴合本地安全与现有代码 | 需要清晰边界和测试 | 推荐 |

最终选择：

```txt
自研 Orchestrator Runtime
  + 借鉴 LangGraph 的模式分类
  + 借鉴 CrewAI 的 Agent/Task/Crew/Flow
  + 借鉴 LlamaIndex 的 event-driven step
  + 借鉴 Microsoft Agent Framework 的 typed workflow / checkpoint / human gate
  + 借鉴 OpenAI Agents SDK 的 handoff / guardrail / tracing
  + 借鉴 PydanticAI 的 complexity ladder / usage limits
```

---

## 4. Agent Cowork 多 Agent 编排的产品目标

### 4.1 对用户看到的价值

普通用户不应该理解 Agent 编排，只需要看到结果：

```txt
用户说：帮我把这个文件夹整理成周报和 PPT。

系统显示：
1. 资料整理员正在阅读 18 个文件
2. 表格助手正在检查 3 个 Excel
3. 报告写手正在生成周报草稿
4. PPT 助手正在生成大纲和页面结构
5. 安全检查员正在确认没有修改原文件、没有外发内容
6. 总控助手正在合并结果，等待你确认
```

### 4.2 对开发者的价值

```txt
- 不重写当前 agent loop
- 不破坏 Plan Mode / Approval / Audit
- 不强制引入 Python runtime
- 每个子 Agent 可独立测试
- 每个 Recipe 可声明需要哪些 Agent
- 每个 Agent 有清晰工具边界、上下文边界、预算边界
```

### 4.3 对企业客户的价值

```txt
- 所有子 Agent 都在本地 Host 的统一策略下运行
- 子 Agent 不能绕过 trusted root jail
- 子 Agent 不能直接拿到全部文件，只能拿到 ContextPacker 分配的切片
- 子 Agent 的模型、工具、文件访问、外发行为全部可审计
- 可以生成“本次任务由哪些 Agent 处理了哪些数据”的 Trust Report
```

---

## 5. 推荐总体架构

```txt
┌──────────────────────────────────────────────────────────────┐
│                        React / Tauri UI                       │
│  Task Inbox | Workflow Timeline | Agent Team View | Approval  │
└───────────────────────────────┬──────────────────────────────┘
                                │ SSE / REST
┌───────────────────────────────▼──────────────────────────────┐
│                         Host API                              │
│ /api/orchestrator/run                                          │
│ /api/orchestrator/runs/:id                                     │
│ /api/orchestrator/cancel                                       │
│ /api/agents                                                    │
│ /api/agents/test                                               │
└───────────────────────────────┬──────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────┐
│                  Orchestrator Runtime                         │
│  OrchestratorEngine                                            │
│  AgentRegistry                                                 │
│  WorkflowRunner                                                │
│  SupervisorRouter                                              │
│  ContextPacker                                                 │
│  BudgetManager                                                 │
│  GuardrailEngine                                               │
│  TraceRecorder                                                 │
│  ResultSynthesizer                                             │
│  VerifierAgentRunner                                           │
└───────────────┬───────────────────┬──────────────────────────┘
                │                   │
┌───────────────▼───────┐   ┌───────▼──────────────────────────┐
│ Existing Agent Loop   │   │ Existing Subagent APIs            │
│ Tool Calling          │   │ /api/subagent/run                 │
│ Plan Mode             │   │ /api/subagent/parallel            │
│ ModelRouter           │   │ AgentParallel tool                │
└───────────────┬───────┘   └───────┬──────────────────────────┘
                │                   │
┌───────────────▼───────────────────▼──────────────────────────┐
│ Tool Registry / MCP / File Ops / Sandbox / Approval / Audit   │
└───────────────────────────────────────────────────────────────┘
```

---

## 6. 核心概念设计

### 6.1 AgentDefinition

```ts
export type AgentId =
  | 'supervisor'
  | 'router'
  | 'researcher'
  | 'file_organizer'
  | 'data_analyst'
  | 'writer'
  | 'ppt_designer'
  | 'word_polisher'
  | 'excel_helper'
  | 'verifier'
  | 'security_reviewer'
  | 'fallback_agent'

export type AgentDefinition = {
  id: AgentId
  displayName: string
  description: string
  rolePrompt: string
  defaultModelProfile: 'cheap' | 'balanced' | 'strong' | 'local'
  allowedTools: string[]
  deniedTools?: string[]
  contextPolicy: AgentContextPolicy
  outputSchema: AgentOutputSchema
  budget: AgentBudget
  riskLevel: 'low' | 'medium' | 'high'
  canWrite: boolean
  canCallNetwork: boolean
  requiresApprovalBeforeRun?: boolean
}
```

### 6.2 AgentContextPolicy

```ts
export type AgentContextPolicy = {
  maxInputChars: number
  canSeeRawFiles: boolean
  canSeeFileNames: boolean
  canSeePriorMemory: boolean
  canSeeOtherAgentScratchpad: boolean
  allowedDataTags: Array<'public' | 'internal' | 'confidential' | 'secret'>
  redactionMode: 'none' | 'secrets_only' | 'strict'
}
```

默认策略：

```txt
researcher：可看原文切片，只读，不写文件。
writer：看摘要和结构化结论，默认不看全部原文。
ppt_designer：看报告大纲和目标风格，不看敏感原始数据。
verifier：看产物 + 引用证据 + 变更预览。
security_reviewer：看 DataTag、工具调用、外发预览、文件变更计划。
supervisor：看任务目标、子结果、预算和状态，不默认看所有 raw content。
```

### 6.3 AgentTask

```ts
export type AgentTask = {
  taskId: string
  runId: string
  parentTaskId?: string
  agentId: AgentId
  title: string
  instruction: string
  inputRefs: ContextRef[]
  expectedOutput: string
  outputSchemaName: string
  priority: 'low' | 'normal' | 'high'
  dependencies: string[]
  timeoutMs: number
  budget: AgentBudget
  approvalPolicy: 'never' | 'before_write' | 'before_network' | 'always'
}
```

### 6.4 AgentResult

```ts
export type AgentResult = {
  taskId: string
  agentId: AgentId
  status: 'succeeded' | 'failed' | 'partial' | 'skipped'
  summary: string
  structured: unknown
  evidenceRefs: EvidenceRef[]
  artifactRefs: string[]
  proposedOps?: FileOpPreview[]
  confidence: number
  warnings: string[]
  usage: AgentUsage
  nextSuggestedTasks?: AgentTask[]
}
```

### 6.5 OrchestrationRun

```ts
export type OrchestrationRun = {
  runId: string
  userGoal: string
  recipeId?: string
  mode: 'workflow' | 'supervisor' | 'router' | 'map_reduce' | 'handoff'
  status: 'planning' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'
  workspaceRoot: string
  securityMode: 'local_strict' | 'enterprise_hybrid' | 'cloud_opt_in'
  agents: AgentId[]
  tasks: AgentTask[]
  results: AgentResult[]
  eventsPath: string
  checkpointPath: string
  auditPath: string
  artifacts: string[]
  startedAt: string
  updatedAt: string
}
```

---

## 7. 最小可行编排模式

### 7.1 Pattern A：Sequential Pipeline

适用：周报、会议纪要、Word 正式化、合同摘要。

```txt
ContextPacker
  → Researcher
  → Writer
  → Verifier
  → SecurityReviewer
  → ArtifactWriter
```

优点：简单、稳定、可解释、成本低。

实现难度：低。

优先级：P0。

### 7.2 Pattern B：Router + Specialist

适用：用户一句话模糊任务，比如“帮我整理一下这些资料”。

```txt
RuleRouter / LlmRouter
  ├─ ExcelHelper
  ├─ WordPolisher
  ├─ PPTDesigner
  ├─ FileOrganizer
  └─ GeneralWriter
        ↓
   ResultSynthesizer
```

建议先做规则路由：

```ts
if files include .xlsx/.csv => include excel_helper
action contains 'PPT/汇报/演示' => include ppt_designer
action contains '正式/润色/通知/邮件' => include word_polisher
action contains '整理/分类/归档' => include file_organizer
else => general_writer
```

只有规则不确定时才调用 LLM Router。

实现难度：中低。

优先级：P0。

### 7.3 Pattern C：Map-Reduce Documents

适用：大量文件夹总结、客户资料汇总、项目资料整理。

```txt
Split files by type/size/topic
  → Parallel Researcher Tasks
  → Partial Summaries
  → Synthesizer
  → Verifier
```

关键优化：

```txt
- 文件 hash 未变时复用旧摘要
- 每个 researcher 只看自己的文件切片
- synthesizer 只看子摘要，不看全部原文
- verifier 抽样回读证据
```

实现难度：中。

优先级：P1。

### 7.4 Pattern D：Critic Loop

适用：报告、PPT、重要邮件、合同风险摘要。

```txt
Writer → Verifier → Writer Revision → Final Verification
```

成本控制：

```txt
- 默认最多 1 轮修订
- 只有 verifier confidence < 0.75 时才触发修订
- 修订时只传问题清单和原产物，不重新传全量上下文
```

实现难度：中。

优先级：P1。

### 7.5 Pattern E：Controlled Handoff

适用：多轮复杂任务，如“先分析 Excel，再生成 Word 报告，再做 PPT”。

```txt
Supervisor
  → handoff(excel_helper)
  → handoff(writer)
  → handoff(ppt_designer)
  → supervisor_final
```

约束：

```txt
- handoff 只能由 Supervisor 或 WorkflowRunner 发起
- 子 Agent 不能自由把任务交给另一个子 Agent
- 每次 handoff 必须记录 reason、contextRefs、budget
- handoff 不自动继承全部上下文
```

实现难度：中高。

优先级：P2。

### 7.6 Pattern F：GroupChat / RoundRobin

适用：专家讨论、头脑风暴、方案评审。

v2.5 不建议默认实现，因为：

```txt
- 对普通办公任务成本高
- token 消耗不可控
- 容易产生重复意见
- 审计和结果归因复杂
- 不适合“傻瓜式办公协作”主线
```

可以保留为 Developer Mode 实验功能。

优先级：P4 或暂缓。

---

## 8. 推荐内置 Agent 小队

### 8.1 总控类

#### supervisor

```txt
中文名：总控助手
职责：理解用户目标、选择 Recipe、拆分任务、调度专家、合并结果、触发审批。
工具：AgentParallel、AgentRun、ContextPack、ArtifactWritePreview、ApprovalRequest。
权限：不能直接修改文件，必须走计划和审批。
```

#### router

```txt
中文名：任务分诊员
职责：判断用户任务属于表格、文档、PPT、整理、总结、写作、检查哪类。
工具：文件类型统计、关键词分类、可选 LLM 分类。
权限：只读。
```

### 8.2 办公类

#### researcher

```txt
中文名：资料整理员
职责：读取文件、提取要点、列出引用来源和证据。
工具：Read、Glob、Grep、ContextPack。
权限：只读。
```

#### writer

```txt
中文名：报告写手
职责：把要点写成周报、通知、纪要、汇报稿、正式文本。
工具：ArtifactDraft。
权限：默认只生成草稿，不直接覆盖原文件。
```

#### excel_helper

```txt
中文名：表格助手
职责：清洗 CSV/XLSX、解释字段、发现异常、生成公式建议、生成汇总表。
工具：本地表格解析工具、CSV writer、XLSX writer。
权限：默认生成副本，不改原表。
```

#### ppt_designer

```txt
中文名：PPT 助手
职责：把报告转成 PPT 大纲、页结构、讲稿和简洁版演示文稿。
工具：PPTX writer、DesignPlugin、ArtifactPreview。
权限：只生成新文件。
```

#### word_polisher

```txt
中文名：Word 润色员
职责：把口语文本改成正式通知、邮件、制度说明、工作报告。
工具：DOCX writer、Markdown writer。
权限：只生成新文件。
```

#### file_organizer

```txt
中文名：文件整理员
职责：识别文件类型、命名混乱、重复文件，提出整理方案。
工具：Glob、Read metadata、FileOpsPreview。
权限：只能生成移动/重命名 preview，必须审批后执行。
```

### 8.3 安全和质量类

#### verifier

```txt
中文名：质量检查员
职责：检查产物是否满足用户目标、是否缺少来源、是否有明显错误。
工具：Read artifact、Read evidence refs、Compare checklist。
权限：只读。
```

#### security_reviewer

```txt
中文名：安全检查员
职责：检查是否越权读取、是否可能外发敏感内容、是否写入危险路径、是否调用高风险工具。
工具：DataTag、PolicyDecision、AuditReader、EgressPreview。
权限：只读，可阻断。
```

#### fallback_agent

```txt
中文名：兜底助手
职责：当专业 Agent 失败时，用最简单方式生成可用草稿或下一步操作建议。
工具：ArtifactDraft、Markdown writer。
权限：低风险。
```

---

## 9. Agent 与 Skills / Recipes / Hooks 的关系

之前已有 Skills / Recipes / Hooks 规划，多 Agent 不应另起炉灶，而要复用三者。

```txt
Skill：某个 Agent 可加载的专业说明书
Recipe：一次端到端办公流程
Hook：每个步骤前后的安全和质量门禁
Agent：执行某类子任务的角色
Orchestrator：调度 Agent、Recipe、Hook 的运行时
```

示例：

```txt
Recipe: folder-to-weekly-report
  uses:
    - skill: summarize-folder
    - skill: weekly-report-format
  agents:
    - researcher
    - writer
    - verifier
    - security_reviewer
  hooks:
    - PreAgentTask
    - PostAgentTask
    - BeforeArtifactWrite
```

---

## 10. Orchestrator Runtime 目录结构

建议新增：

```txt
apps/host/src/orchestrator/
  index.ts
  types.ts
  orchestrator-engine.ts
  workflow-runner.ts
  supervisor-router.ts
  agent-registry.ts
  agent-runner.ts
  agent-parallel-runner.ts
  context-packer.ts
  result-synthesizer.ts
  verifier-runner.ts
  budget-manager.ts
  guardrail-engine.ts
  checkpoint-store.ts
  trace-recorder.ts
  events.ts
  errors.ts
  recipes/
    folder-summary.recipe.ts
    weekly-report.recipe.ts
    excel-cleanup.recipe.ts
    ppt-from-folder.recipe.ts
    file-organizer.recipe.ts
  agents/
    supervisor.agent.ts
    researcher.agent.ts
    writer.agent.ts
    excel-helper.agent.ts
    ppt-designer.agent.ts
    verifier.agent.ts
    security-reviewer.agent.ts
apps/host/src/routes/
  orchestrator-routes.ts
apps/host/test/orchestrator/
  orchestrator-engine.test.ts
  workflow-runner.test.ts
  router.test.ts
  map-reduce.test.ts
  budget-manager.test.ts
  guardrail-engine.test.ts
  checkpoint-resume.test.ts
scripts/
  smoke-orchestrator-weekly-report.ts
  smoke-orchestrator-map-reduce.ts
  smoke-orchestrator-office-team.ts
  smoke-orchestrator-resume.ts
  smoke-orchestrator-async-cancel.ts
```

---

## 11. API 设计

### 11.1 启动编排任务

```http
POST /api/orchestrator/run
Content-Type: application/json
```

```ts
export type StartOrchestrationRequest = {
  workspaceRoot: string
  userGoal: string
  recipeId?: string
  inputPaths?: string[]
  mode?: 'auto' | 'workflow' | 'supervisor' | 'router' | 'map_reduce' | 'handoff'
  securityMode: 'local_strict' | 'enterprise_hybrid' | 'cloud_opt_in'
  maxAgents?: number
  maxParallel?: number
  maxTotalModelCalls?: number
  maxTotalTokens?: number
  dryRun?: boolean
}
```

返回：

```ts
export type StartOrchestrationResponse = {
  runId: string
  status: 'planning' | 'running' | 'waiting_approval'
  selectedRecipeId?: string
  agents: Array<{ id: AgentId; displayName: string; taskCount: number }>
  eventsUrl: string
}
```

### 11.2 获取运行详情

```http
GET /api/orchestrator/runs/:runId
```

返回：

```ts
export type OrchestrationRunDetail = {
  run: OrchestrationRun
  timeline: OrchestrationEvent[]
  tasks: AgentTask[]
  results: AgentResult[]
  artifacts: ArtifactRef[]
  approvals: ApprovalSummary[]
  budget: BudgetSnapshot
}
```

### 11.3 取消任务

```http
POST /api/orchestrator/runs/:runId/cancel
```

语义：

```txt
- 停止尚未开始的子任务
- 已经运行中的只允许 cooperative cancellation
- 保留 checkpoint
- 生成 partial result
- 写 audit event
```

### 11.4 预览编排图

```http
POST /api/orchestrator/graph/preview
```

用途：让前端在真正执行前显示：

```txt
本任务将使用：资料整理员、报告写手、质量检查员、安全检查员。
预计读取：12 个文件。
预计生成：1 个 Markdown、1 个 DOCX。
不会：删除、覆盖、上传、执行命令。
```

---

## 12. OrchestrationEvent 设计

```ts
export type OrchestrationEvent =
  | { type: 'run_started'; runId: string; goal: string; at: string }
  | { type: 'recipe_selected'; runId: string; recipeId: string; reason: string; at: string }
  | { type: 'handoff_started'; runId: string; taskId: string; fromAgentId?: AgentId; toAgentId: AgentId; reason: string; contextRefIds: string[]; budget: AgentBudget; at: string }
  | { type: 'agent_task_started'; runId: string; taskId: string; agentId: AgentId; title: string; at: string }
  | { type: 'agent_task_progress'; runId: string; taskId: string; message: string; percent?: number; at: string }
  | { type: 'agent_task_completed'; runId: string; taskId: string; agentId: AgentId; status: string; summary: string; at: string }
  | { type: 'agent_task_failed'; runId: string; taskId: string; agentId: AgentId; error: string; fallbackUsed: boolean; at: string }
  | { type: 'synthesis_started'; runId: string; at: string }
  | { type: 'verification_completed'; runId: string; passed: boolean; warnings: string[]; at: string }
  | { type: 'approval_requested'; runId: string; approvalId: string; reason: string; at: string }
  | { type: 'artifact_created'; runId: string; path: string; kind: string; at: string }
  | { type: 'budget_updated'; runId: string; budget: BudgetSnapshot; at: string }
  | { type: 'run_completed'; runId: string; status: string; at: string }
```

事件必须同时写入：

```txt
.AgentCowork/runs/<runId>.json
.AgentCowork/runs/<runId>.events.jsonl
.AgentCowork/audit/orchestrator.jsonl
```

---

## 13. 成本控制设计

### 13.1 多 Agent 成本原则

多 Agent 最大问题不是实现，而是成本、延迟和上下文爆炸。因此必须默认开启预算管理。

```ts
export type AgentBudget = {
  maxModelCalls: number
  maxToolCalls: number
  maxInputTokens: number
  maxOutputTokens: number
  maxRuntimeMs: number
  maxFilesRead: number
  maxBytesRead: number
}
```

默认配置：

| Agent | maxModelCalls | maxToolCalls | maxRuntimeMs | 说明 |
|---|---:|---:|---:|---|
| router | 0-1 | 5 | 10s | 优先规则路由 |
| researcher | 1 | 20 | 60s | 可并发 |
| writer | 1 | 5 | 60s | 只看摘要 |
| verifier | 1 | 10 | 45s | 只读产物和证据 |
| security_reviewer | 0-1 | 10 | 20s | 优先规则检查 |
| supervisor | 1-2 | 10 | 60s | 负责汇总 |

### 13.2 模型分层

```txt
cheap/local：router、文件分类、简单校验
balanced：researcher、writer 普通任务
strong：最终报告、复杂合成、重要 PPT
no-model：文件统计、规则路由、安全检查、路径检查、hash 缓存
```

### 13.3 缓存命中

```txt
- fileHash + skillId + agentId → 文件摘要缓存
- userGoal normalized + fileManifestHash → Recipe 选择缓存
- agentTask inputHash + agentVersion → 子任务结果缓存
- artifactHash + verifierVersion → 校验结果缓存
```

缓存策略：

```ts
export type AgentCacheKey = {
  agentId: AgentId
  agentVersion: string
  skillVersion?: string
  modelProfile: string
  inputHash: string
  contextPolicyHash: string
}
```

---

## 14. 上下文隔离与安全

### 14.1 子 Agent 不应默认看到全部上下文

错误做法：

```txt
把用户输入、全部文件内容、全部历史记忆、其他 Agent 思考过程一次性传给每个 Agent。
```

正确做法：

```txt
ContextPacker 根据 AgentContextPolicy 生成最小上下文包。
```

```ts
export type ContextPack = {
  contextPackId: string
  agentId: AgentId
  taskId: string
  userGoalSummary: string
  fileManifest?: FileManifestEntry[]
  excerpts?: FileExcerpt[]
  priorSummaries?: SummaryRef[]
  memoryFacts?: MemoryFact[]
  forbidden?: string[]
  redactionReport: RedactionReport
}
```

### 14.2 工具权限矩阵

| Agent | Read | Write | Edit | Shell | WebFetch | MCP | Approval Required |
|---|---:|---:|---:|---:|---:|---:|---:|
| router | ✅ | ❌ | ❌ | ❌ | ❌ | 只读 | 否 |
| researcher | ✅ | ❌ | ❌ | ❌ | 受控 | 只读 | 网络前审批 |
| writer | 读摘要 | draft only | ❌ | ❌ | ❌ | ❌ | 写产物前审批 |
| excel_helper | ✅ | 新文件 | ❌ | ❌ | ❌ | 表格工具 | 写产物前审批 |
| ppt_designer | 读摘要 | 新文件 | ❌ | ❌ | ❌ | 设计工具 | 写产物前审批 |
| file_organizer | 元数据 | preview only | ❌ | ❌ | ❌ | ❌ | 移动/重命名前审批 |
| verifier | ✅ | ❌ | ❌ | ❌ | ❌ | 只读 | 否 |
| security_reviewer | 审计数据 | ❌ | ❌ | ❌ | ❌ | 策略工具 | 可阻断 |

### 14.3 安全 Hook

新增 Hook event：

```ts
export type OrchestratorHookEvent =
  | 'BeforeOrchestrationStart'
  | 'BeforeAgentTaskStart'
  | 'AfterAgentTaskEnd'
  | 'BeforeHandoff'
  | 'BeforeParallelFanout'
  | 'BeforeSynthesis'
  | 'BeforeArtifactWrite'
  | 'BeforeApprovalRequest'
  | 'AfterRunComplete'
```

内置 Hook：

```txt
- max-agent-count：单次任务最多 6 个 Agent
- max-parallel-count：默认最多并发 3 个子任务
- no-raw-secret-to-writer：writer 不接收原始密钥片段
- no-cloud-context-in-local-strict：Local Strict 禁止云模型子 Agent
- no-write-without-approval：任何写入必须走 Approval
- no-shell-in-subagent：默认禁止子 Agent Shell
- no-cross-agent-scratchpad-leak：默认不共享完整 scratchpad
```

---

## 15. Workflow DSL

为了低成本，先不要做复杂可视化编辑器，使用 TypeScript 定义内置 Recipe。后续再支持 JSON/YAML。

### 15.1 TypeScript Recipe

```ts
export const weeklyReportRecipe: OrchestrationRecipe = {
  id: 'weekly-report',
  displayName: '一键周报',
  description: '读取本周资料，生成周报草稿和可选 PPT 大纲',
  match: (ctx) => ctx.goal.includes('周报') || ctx.goal.includes('本周'),
  agents: ['researcher', 'writer', 'verifier', 'security_reviewer'],
  graph: [
    { id: 'pack', kind: 'context_pack', next: ['research'] },
    { id: 'research', kind: 'agent_task', agentId: 'researcher', next: ['write'] },
    { id: 'write', kind: 'agent_task', agentId: 'writer', next: ['verify'] },
    { id: 'verify', kind: 'agent_task', agentId: 'verifier', next: ['security'] },
    { id: 'security', kind: 'agent_task', agentId: 'security_reviewer', next: ['approval'] },
    { id: 'approval', kind: 'approval_gate', next: ['artifact'] },
    { id: 'artifact', kind: 'artifact_write', next: [] }
  ]
}
```

### 15.2 JSON Recipe（P2）

```json
{
  "id": "folder-to-ppt",
  "displayName": "文件夹转 PPT",
  "agents": ["researcher", "writer", "ppt_designer", "verifier", "security_reviewer"],
  "steps": [
    { "id": "pack", "type": "context_pack" },
    { "id": "research", "type": "parallel_agent", "agent": "researcher", "dependsOn": ["pack"] },
    { "id": "outline", "type": "agent", "agent": "writer", "dependsOn": ["research"] },
    { "id": "slides", "type": "agent", "agent": "ppt_designer", "dependsOn": ["outline"] },
    { "id": "verify", "type": "agent", "agent": "verifier", "dependsOn": ["slides"] },
    { "id": "security", "type": "agent", "agent": "security_reviewer", "dependsOn": ["verify"] },
    { "id": "approval", "type": "approval_gate", "dependsOn": ["security"] },
    { "id": "write", "type": "artifact_write", "dependsOn": ["approval"] }
  ]
}
```

---

## 16. 结果合成器 ResultSynthesizer

多 Agent 输出不能简单拼接，需要合成器统一风格、去重、处理冲突。

```ts
export type SynthesisInput = {
  userGoal: string
  recipeId?: string
  agentResults: AgentResult[]
  artifactRequirements: ArtifactRequirement[]
  styleGuide?: string
  safetyConstraints: string[]
}

export type SynthesisOutput = {
  finalSummary: string
  artifactDrafts: ArtifactDraft[]
  unresolvedQuestions: string[]
  conflicts: Array<{
    topic: string
    agentA: string
    agentB: string
    resolution: string
  }>
  citations: EvidenceRef[]
  confidence: number
}
```

合成规则：

```txt
1. 先按用户目标排序，不按 Agent 顺序排序。
2. 相同结论合并，保留最强证据。
3. 冲突结论必须标注，不允许悄悄选一个。
4. 低置信度内容进入“待确认”区。
5. 最终产物只引用 EvidenceRef，不引用 Agent 内部 scratchpad。
```

---

## 17. Verifier 质量校验

Verifier 应尽量规则化，减少模型成本。

### 17.1 通用 checklist

```txt
- 是否回答了用户目标？
- 是否生成了用户要求的文件格式？
- 是否引用了读取来源？
- 是否有明显空段落、占位符、乱码？
- 是否改动原文件？如果改动，是否有审批？
- 是否包含密钥、身份证号、手机号等敏感信息？
- 是否出现“我无法访问文件”但实际上已读取？
- 是否有模型幻觉的来源文件名？
```

### 17.2 办公场景 checklist

周报：

```txt
- 本周完成事项
- 关键数据
- 风险和阻塞
- 下周计划
- 需要领导协助事项
```

PPT：

```txt
- 首页标题
- 背景/目标
- 关键发现
- 数据支撑
- 方案/进展
- 风险
- 下一步
```

Excel：

```txt
- 字段名是否规范
- 是否有空值/重复/异常值
- 是否保留原始表
- 是否生成清洗副本
- 公式是否有说明
```

---

## 18. UI 设计：不要让小白看到复杂 Agent 概念

### 18.1 前端展示名

| 技术名 | 用户看到 |
|---|---|
| supervisor | 总控助手 |
| router | 分诊助手 |
| researcher | 资料整理员 |
| writer | 报告写手 |
| excel_helper | 表格助手 |
| ppt_designer | PPT 助手 |
| verifier | 质量检查员 |
| security_reviewer | 安全检查员 |

### 18.2 任务时间线

```txt
AI 小队正在处理你的任务

✅ 分诊助手：识别为“文件夹生成周报”
✅ 资料整理员：已读取 12 个文件，提取 38 条要点
⏳ 报告写手：正在生成周报草稿
等待：质量检查员、安全检查员
```

### 18.3 展示预算，但用小白语言

技术预算不要展示 tokens，展示：

```txt
本次任务预计消耗：低
读取文件：12 个
将生成：2 个新文件
不会修改原文件
不会联网
```

开发者模式再展示：

```txt
modelCalls: 4 / 8
parallelTasks: 3 / 3
inputTokens: 18,203 / 60,000
cacheHits: 9
```

---

## 19. 数据库存储设计

如果当前 runs 已经是 JSON 文件，P0 可继续用文件；P1 再落 SQLite。

### 19.1 orchestrator_runs

```sql
CREATE TABLE orchestrator_runs (
  run_id TEXT PRIMARY KEY,
  user_goal TEXT NOT NULL,
  recipe_id TEXT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  security_mode TEXT NOT NULL,
  events_path TEXT NOT NULL,
  checkpoint_path TEXT NOT NULL,
  audit_path TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
```

### 19.2 agent_tasks

```sql
CREATE TABLE agent_tasks (
  task_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  parent_task_id TEXT,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL,
  dependencies_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY(run_id) REFERENCES orchestrator_runs(run_id)
);
```

### 19.3 agent_results

```sql
CREATE TABLE agent_results (
  result_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  structured_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  artifacts_json TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES agent_tasks(task_id)
);
```

---

## 20. 实施里程碑

### P0：1 周内可完成的最小编排层

目标：不要复杂，不要图编辑器，先跑通 3 个 Agent 串联。

任务：

```txt
1. 新增 orchestrator/types.ts
2. 新增 agent-registry.ts，内置 researcher/writer/verifier/security_reviewer
3. 新增 workflow-runner.ts，支持 sequential steps
4. 新增 trace-recorder.ts，写 events.jsonl
5. 新增 budget-manager.ts，限制 modelCalls/toolCalls/runtime
6. 新增 context-packer.ts，只给每个 Agent 最小上下文
7. 新增 /api/orchestrator/run
8. 新增 weekly-report.recipe.ts
9. 前端时间线复用 child_start/child_end 展示
10. smoke-orchestrator-weekly-report.ts
```

验收：

```txt
用户输入“把这些资料生成周报”
→ router 选择 weekly-report
→ researcher 只读文件
→ writer 生成草稿
→ verifier 检查
→ security_reviewer 检查
→ approval 后写入 .AgentCowork/artifacts/周报.md
→ 全程生成 events.jsonl 和 audit
```

### P1：2-3 周，加入并发与 Map-Reduce

目标：处理多个文件时真正体现多 Agent 价值。

任务：

```txt
1. agent-parallel-runner.ts 接入现有 /api/subagent/parallel 或 AgentParallel
2. MapReduceRecipe 支持文件分片
3. ResultSynthesizer 合并多个 researcher 输出
4. 文件摘要缓存 fileHash → summary
5. 增加 folder-summary.recipe.ts
6. 增加 ppt-from-folder.recipe.ts 初版
7. UI 显示多个子任务卡片
8. 支持 cancel
9. 支持 partial result
```

验收：

```txt
50 个文件夹资料
→ 自动分 3-5 个 researcher 子任务并发总结
→ 合成总报告
→ 生成 PPT 大纲
→ 质量检查员抽样回读来源
→ 失败一个子任务时仍生成 partial report
```

### P2：4-6 周，加入 Supervisor 和受控 Handoff

目标：让复杂办公任务能拆多步，但仍可控。

任务：

```txt
1. supervisor-router.ts 支持任务拆分
2. handoff.ts 支持 supervisor 发起 handoff
3. 每次 handoff 写 trace event
4. 增加 controlled_handoff recipe mode
5. 增加 excel-cleanup → report → ppt 的组合流程
6. 增加 checkpoint-store.ts
7. 支持 resume from checkpoint
8. 支持 human gate：用户选择继续/跳过/修改目标
```

验收：

```txt
用户输入“把这个销售表整理一下，做成汇报材料和 PPT”
→ router 识别 Excel + 报告 + PPT
→ excel_helper 清洗并输出摘要
→ writer 生成汇报稿
→ ppt_designer 生成 PPT
→ verifier 检查数据引用
→ 用户审批写入
```

### P3：6-8 周，加入可配置 Agent / Role Pack

目标：为不同岗位扩展专家小队。

任务：

```txt
1. .agent-cowork/agents/*.agent.json
2. AgentDefinition schema 校验
3. Role Pack 可按需安装：行政包、销售包、财务包、HR 包、项目包
4. Agent 权限卡片
5. Agent 测试按钮
6. 管理员 allowlist / denylist
7. Agent version + cache invalidation
```

验收：

```txt
安装“销售办公包”后新增：客户跟进助手、报价单助手、CRM 摘要助手。
卸载后相关 Recipe 不再可选。
```

### P4：8 周后，实验高级编排

目标：只在开发者/企业高级版中启用。

候选：

```txt
- RoundRobin 专家讨论
- Debate / Critic 多轮评审
- Graph visual editor
- Distributed worker pool
- Benchmark dashboard
- Auto agent generation
- Agent evaluation and regression tests
```

---

## 21. 两周 MVP 推荐范围

两周内不要做太多。最有价值的是：

```txt
1. OrchestratorEngine
2. AgentRegistry
3. Sequential WorkflowRunner
4. Parallel Researcher Map-Reduce
5. ResultSynthesizer
6. Verifier
7. SecurityReviewer
8. WeeklyReport Recipe
9. FolderSummary Recipe
10. UI Agent Team Timeline
```

不做：

```txt
- 可视化拖拽编排器
- 自由群聊
- 子 Agent 之间互相随意 handoff
- 分布式 worker
- 自动生成 Agent
- 复杂 benchmark 平台
```

---

## 22. 代码骨架示例

### 22.1 AgentRegistry

```ts
export class AgentRegistry {
  private agents = new Map<AgentId, AgentDefinition>()

  register(agent: AgentDefinition) {
    if (this.agents.has(agent.id)) throw new Error(`Agent already registered: ${agent.id}`)
    this.agents.set(agent.id, agent)
  }

  get(agentId: AgentId): AgentDefinition {
    const agent = this.agents.get(agentId)
    if (!agent) throw new Error(`Unknown agent: ${agentId}`)
    return agent
  }

  list(): AgentDefinition[] {
    return [...this.agents.values()]
  }
}
```

### 22.2 WorkflowRunner

```ts
export class WorkflowRunner {
  constructor(
    private readonly agentRunner: AgentRunner,
    private readonly trace: TraceRecorder,
    private readonly budget: BudgetManager,
    private readonly guardrails: GuardrailEngine,
  ) {}

  async run(recipe: OrchestrationRecipe, ctx: OrchestrationContext): Promise<OrchestrationRun> {
    await this.trace.append({ type: 'run_started', runId: ctx.runId, goal: ctx.userGoal, at: new Date().toISOString() })

    const state = createInitialState(recipe, ctx)

    while (!state.completed) {
      const runnableSteps = getRunnableSteps(recipe, state)
      if (runnableSteps.length === 0) throw new Error('Workflow deadlock: no runnable steps')

      for (const step of runnableSteps) {
        await this.guardrails.beforeStep(step, state)
        await this.budget.assertCanRun(step)
        await runStep(step, state, this.agentRunner, this.trace)
        await this.guardrails.afterStep(step, state)
      }
    }

    await this.trace.append({ type: 'run_completed', runId: ctx.runId, status: 'completed', at: new Date().toISOString() })
    return state.toRun()
  }
}
```

### 22.3 AgentRunner

```ts
export class AgentRunner {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly contextPacker: ContextPacker,
    private readonly modelRouter: ModelRouter,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  async runTask(task: AgentTask): Promise<AgentResult> {
    const agent = this.registry.get(task.agentId)
    const context = await this.contextPacker.pack(agent, task)

    const response = await runExistingAgentLoop({
      agentName: agent.displayName,
      systemPrompt: agent.rolePrompt,
      userPrompt: task.instruction,
      context,
      allowedTools: agent.allowedTools,
      modelProfile: agent.defaultModelProfile,
      outputSchema: agent.outputSchema,
      budget: task.budget,
    })

    return parseAgentResult(task, agent, response)
  }
}
```

### 22.4 ResultSynthesizer

```ts
export class ResultSynthesizer {
  async synthesize(input: SynthesisInput): Promise<SynthesisOutput> {
    const succeeded = input.agentResults.filter(r => r.status === 'succeeded' || r.status === 'partial')
    const warnings = input.agentResults.flatMap(r => r.warnings)

    // P0：先用确定性模板合并。
    // P1：复杂冲突再调用 writer/supervisor 进行 LLM synthesis。
    return {
      finalSummary: buildDeterministicSummary(input.userGoal, succeeded, warnings),
      artifactDrafts: buildArtifactDrafts(input, succeeded),
      unresolvedQuestions: collectUnresolvedQuestions(succeeded),
      conflicts: detectConflicts(succeeded),
      citations: succeeded.flatMap(r => r.evidenceRefs),
      confidence: averageConfidence(succeeded),
    }
  }
}
```

---

## 23. 办公场景 Recipe 优先级

| 优先级 | Recipe | Agent 组合 | 商业价值 | 实现难度 |
|---|---|---|---:|---:|
| P0 | 一键周报 | researcher → writer → verifier | 高 | 低 |
| P0 | 文件夹总结 | parallel researcher → synthesizer → verifier | 高 | 中 |
| P0 | Word 改正式 | writer → verifier | 高 | 低 |
| P1 | 文件夹转 PPT | researcher → writer → ppt_designer → verifier | 高 | 中 |
| P1 | Excel 急救 | excel_helper → verifier → writer | 高 | 中 |
| P1 | 会议纪要 | researcher → writer → action_checker | 高 | 低 |
| P2 | 销售跟进包 | researcher → crm_writer → verifier | 中高 | 中 |
| P2 | 财务报销检查 | data_analyst → policy_checker → verifier | 中高 | 中高 |
| P2 | 合同风险摘要 | researcher → legal_summary → security_reviewer | 高 | 中高 |

---

## 24. 测试计划

### 24.1 单元测试

```txt
- AgentRegistry 注册/查询/重复注册
- ContextPacker 是否遵守 canSeeRawFiles / allowedDataTags
- BudgetManager 是否阻止超预算
- WorkflowRunner 是否按依赖顺序执行
- ParallelRunner 是否限制并发
- ResultSynthesizer 是否处理 partial/failed
- GuardrailEngine 是否阻断写入型子 Agent
```

### 24.2 集成测试

```txt
npm run test:host -- orchestrator
node scripts/run-host-node.mjs scripts/smoke-orchestrator-weekly-report.ts
node scripts/run-host-node.mjs scripts/smoke-orchestrator-map-reduce.ts
node scripts/run-host-node.mjs scripts/smoke-orchestrator-office-team.ts
node scripts/run-host-node.mjs scripts/smoke-orchestrator-ppt-from-folder.ts
node scripts/run-host-node.mjs scripts/smoke-orchestrator-summary-cache.ts
node scripts/run-host-node.mjs scripts/smoke-orchestrator-resume.ts
node scripts/run-host-node.mjs scripts/smoke-orchestrator-async-cancel.ts
```

### 24.3 安全测试

```txt
1. 子 Agent 尝试读取 trusted root 外路径 → 拒绝
2. writer 尝试调用 Shell → 拒绝
3. security_reviewer 检测云模型外发 → Local Strict 下阻断
4. file_organizer 尝试直接 move 文件 → 必须产生 preview + approval
5. 子 Agent 超预算 → 413 或 partial result
6. verifier 发现产物引用不存在文件 → fail verification
```

### 24.4 UI smoke

```txt
- 任务时间线显示多个 Agent 状态
- 并发子任务能分组显示
- 失败子任务显示可理解原因
- 产物区显示最终合成文件
- 审批弹窗显示“哪些 Agent 提出了哪些操作”
- Developer Mode 显示 modelCalls / toolCalls / cacheHits
```

---

## 25. 风险与规避

### 风险 1：Agent 太多，成本和延迟飙升

规避：

```txt
- 默认最多 4 个 Agent
- 默认最多并发 3 个
- 规则路由优先，不确定再用 LLM
- 简单任务用 Skill，不用多 Agent
- 文件摘要缓存
```

### 风险 2：子 Agent 输出互相矛盾

规避：

```txt
- ResultSynthesizer 检测冲突
- Verifier 标记低置信度
- 冲突项进入“待确认”而不是强行合并
```

### 风险 3：子 Agent 越权读取或修改文件

规避：

```txt
- ContextPacker 最小上下文
- ToolBinding 白名单
- no-write-without-approval Hook
- trusted root jail 复用现有 path-policy
```

### 风险 4：多 Agent 难以审计

规避：

```txt
- 每个 AgentTask 有 taskId
- 每个工具调用带 taskId / agentId
- events.jsonl 全链路记录
- 最终产物引用 evidenceRefs
```

### 风险 5：过度框架化，拖慢产品迭代

规避：

```txt
- P0 只支持 sequential workflow
- P1 才支持 parallel map-reduce
- P2 才支持 controlled handoff
- P4 才考虑可视化编排器
```

---

## 26. 高性价比实现清单（2026-07-05 状态版）

状态口径：

```txt
✅ 已有可复用基础：当前仓库已经存在并有测试覆盖，可作为 2.5 编排层底座。
✅ P0 后端最小编排层：typed runtime + sequential state machine + weekly-report HTTP smoke 已落地。
✅ P0 UI 产品面：Agent Team Timeline 已补本地可验证视图。✅ P0 checkpoint/resume 基础能力：checkpoint store、checkpoint URL、非终态 checkpoint HTTP resume 已补并本地验证。✅ P0 provider/async/cancel：typed provider adapter、ProviderChatResult typed parse、`/api/orchestrator/run-async`、cooperative cancel 已补并通过 fake local OpenAI-compatible provider smoke。✅ P1 map-reduce 基础：map_reduce 可运行 agent_task 真并行调度已测。✅ P1 文件摘要缓存：按租户分区的 `fileHash + recipeId + agentId` FileSummaryCache 已接入 WorkflowRunner 与 HTTP route,并通过 route 级复用测试和真实 Host HTTP smoke。✅ 本轮体验闭环：模型选择器已展示模态/上下文长度,主对话流已支持自动压缩当前线程上下文并在 UI 显示压缩进度。✅ 当前源码桌面侧：`npm run build:host`、`cargo tauri build --no-bundle --ci`、`cargo tauri build --ci --bundles nsis`、rebuilt sidecar direct smoke、真实 Kimi API smoke、当前 installer 重装、installed smoke 与 WebView/a11y 深验已通过。🟡 剩余产品面：生产代码签名、正式 updater endpoint/私钥、clean tag release 复验与产品化发布证据仍待补。
⏳ P1/P2 后置：等 P0 可运行、可审计、可恢复后再做。
❌ 不建议做：会放大成本、风险或维护面。
```

### 已有可复用基础

```txt
✅ /api/subagent/run：顺序子代理计划执行，带 contextBudgetBytes、maxSteps、run record 和事件。
✅ /api/subagent/parallel：并发子代理执行，带 maxAgents、maxConcurrency、contextBudgetBytes。
✅ AgentParallel tool：主 agent 可派发并发子任务，发 child_start/child_end 生命周期事件。
✅ Recipes：已有会议纪要、表格清洗、报销、总结报告、周报、PPT、邮件等确定性办公配方。
✅ Approval/Audit/RunStore：配方和子代理都复用可审批操作、run record、runs index、事件时间线。
```

### P0 必做

```txt
✅ AgentDefinition schema：已新增 typed contract，AgentResult.structured 收敛为 JsonObject，不把 unknown 扩散到编排层。
✅ AgentRegistry：已注册 supervisor/researcher/writer/verifier/security_reviewer 五类内置 Agent。
✅ OrchestratorState machine：已用显式 transition table 约束 run status，不复制“大 option 包 + 可变标志位”模式。
✅ ContextPacker：已按 AgentContextPolicy 裁剪可见数据、处理 raw/summary、过滤 dataTags 并做 secret-like redaction。
✅ BudgetManager：已统一 run/task 预算快照和 budget_updated 事件。
✅ WorkflowRunner sequential：已支持固定 Recipe 的顺序步骤，weekly-report recipe 已跑通。
✅ ResultSynthesizer：P0 已用确定性合成，保留 warnings/confidence/evidenceRefs。
✅ Verifier：P0 已作为独立 AgentTask 执行规则型 verification 输出。
✅ SecurityReviewer：P0 已作为独立 AgentTask 执行规则策略，不绕过 TrustedRoot/trace。
✅ OrchestrationEvent JSONL：已独立记录 run、agent task、budget、result、completion 事件。
✅ /api/orchestrator/run + detail：已接入真实 Host 路由链，支持 idempotency、run store、runs index、tenant scoped detail。
✅ UI Agent Team Timeline：已落地右侧 Agent Team 视图，从 `/api/runs` 找最新 orchestrator run 并读取详情，展示 agent 状态、timeline、budget、evidence/warnings trust 摘要。
✅ 真实 provider/子代理 adapter：P0 已有 typed provider adapter、ProviderChatResult typed parse 与只读 subagent worker；provider 路径已用 fake local OpenAI-compatible fetch 验证,并在用户授权后加载 `.env` 用真实 Kimi API smoke 验证 `kimi-k2.7-code` 可用,证据 `build/kimi-api-smoke-report.json`。
✅ checkpoint/resume + async cancel：P0 run 会写脱敏 checkpoint，detail 响应暴露 checkpointPath/checkpointUrl，`POST /api/orchestrator/runs/:runId/resume` 可从非终态 checkpoint 续跑并写回 run detail；`POST /api/orchestrator/run-async` 会预写 running run/checkpoint 并注册 AbortSignal，`/cancel` 可 cooperative cancel 活跃 provider-backed run；completed checkpoint resume 返回 409。
```

### P1/P2 可后置

```txt
✅ Parallel researcher Map-Reduce：map_reduce 可运行 agent_task 真并行调度已实现并测试；文件摘要缓存已补本地闭环(`output/smoke/orchestrator-summary-cache.json`)
✅ PPT from folder 编排 Recipe：已新增 `ppt-from-folder` recipe,走只读 subagent adapter,并通过真实 Host HTTP smoke
✅ CheckpointStore + resume 基础 HTTP 能力
✅ Controlled handoff MVP：`handoff` recipe mode 已由 WorkflowRunner 在 agent_task 前写入 `handoff_started` trace,记录 reason、contextRefIds、budget、from/to agent；office-team 与 ppt-from-folder 已通过 focused tests 和真实 Host HTTP smoke 断言
⏳ Role Pack / 自定义 Agent
⏳ Graph visual editor
⏳ Distributed worker pool
⏳ Benchmark leaderboard
```

### 不建议做

```txt
❌ 让子 Agent 自由互相聊天
❌ 每个任务默认启动 8-10 个 Agent
❌ 把所有文件原文发给每个 Agent
❌ 绕开现有 Approval / Audit
❌ 为了多 Agent 引入独立 Python 服务作为核心路径
❌ 在现有 tool-loop / executor 的 option bag 上继续横向加标志位
```
---

## 27. 最终推荐路线图

```txt
第 1 阶段：Workflow First
- 顺序执行
- 固定 Recipe
- 固定 Agent 小队
- 本地安全审计

第 2 阶段：Parallel First
- 文件分片
- 并发 researcher
- map-reduce 合成
- 缓存命中

第 3 阶段：Supervisor First
- 任务拆解
- 受控 handoff
- 失败兜底
- 人类确认 gate

第 4 阶段：Role Pack First
- 岗位专家包
- 自定义 Agent
- 企业策略
- 权限卡片

第 5 阶段：Visual / Enterprise
- 可视化编排器
- 运行监控
- 评测集
- 企业报告
```

---

## 28. 推荐的开发落地顺序

按代码提交顺序建议如下：

```txt
PR-1: orchestrator types + event recorder + run store
PR-2: agent registry + built-in agents
PR-3: context packer + budget manager
PR-4: sequential workflow runner + weekly-report recipe
PR-5: result synthesizer + verifier + security reviewer
PR-6: /api/orchestrator/run + SSE events
PR-7: UI Agent Team Timeline
PR-8: parallel map-reduce researcher
PR-9: cache and partial result
PR-10: controlled handoff MVP
```

每个 PR 都要有对应 smoke，避免变成“大而全不可验证”。

---

## 29. 参考资料

以下资料用于提炼设计模式，不建议直接照搬运行时：

1. LangChain Multi-Agent 文档：Subagents、Handoffs、Skills、Router、Custom Workflow、context engineering。
   https://docs.langchain.com/oss/python/langchain/multi-agent
2. LangGraph 概览：long-running stateful agents、low-level orchestration。
   https://docs.langchain.com/oss/python/langgraph/overview
3. CrewAI 文档：Agents、Crews、Flows、Tasks、guardrails、memory、knowledge、observability。
   https://docs.crewai.com/
4. Microsoft Agent Framework：agents vs workflows、typed graph workflow、session state、telemetry、checkpoint/human-in-the-loop 思路。
   https://learn.microsoft.com/en-us/agent-framework/overview/
5. AutoGen 迁移说明：AutoGen 的 GroupChat、event-driven runtime，以及向 Microsoft Agent Framework 演进。
   https://learn.microsoft.com/en-us/agent-framework/migration-guide/from-autogen/
6. LlamaIndex Workflows：event-driven、step-based workflow。
   https://developers.llamaindex.ai/python/llamaagents/workflows/
7. OpenAI Agents SDK Python：Agent loop、handoffs、guardrails、sessions、tracing、MCP。
   https://openai.github.io/openai-agents-python/
8. OpenAI Agents SDK TypeScript：TypeScript-first、agent loop、sandbox execution、handoffs、guardrails、sessions、tracing、Zod schema。
   https://openai.github.io/openai-agents-js/
9. PydanticAI Multi-Agent Patterns：delegation、programmatic handoff、graph-based control flow、deep agents、usage limits。
   https://pydantic.dev/docs/ai/guides/multi-agent-applications/

---

## 30. 最终判断

Agent Cowork 的多 Agent 编排不应该追求“看起来像论文里的 swarm”，而应该服务于你的核心产品方向：

```txt
本地优先
安全可控
小白可用
办公协作
成本可控
全程可审计
```

因此，最适合你的多 Agent 路线是：

> **确定性 Recipe 编排为主，Supervisor 调度为辅，子 Agent 并发用于资料处理，Verifier / SecurityReviewer 作为质量与安全闭环。**

这条路线成本最低、最容易实现、最贴合现有架构，也最容易形成企业级本地安全办公 Agent 的产品护城河。
---

## 31. 2026-07-05 当前仓库落地状态

### 31.1 本地已存在的底座

本次按当前源码复核，以下能力不是计划假设，而是当前仓库已经存在：

| 能力 | 当前文件 | 状态 | 说明 |
|---|---|---|---|
| 顺序子代理执行 | `apps/host/src/runtime/subagent.ts` | 已有 | 支持固定步骤、context budget、max steps、run record、events。 |
| 并行子代理执行 | `apps/host/src/runtime/subagent-parallel.ts` | 已有 | 支持 max agents、max concurrency、独立 child run、聚合 run record。 |
| 主 agent 并发子任务工具 | `apps/host/src/kimi/agent/parallel-agent-tool.ts` | 已有 | `AgentParallel` 受任务数、并发数、上下文字节预算约束，并发出 `child_start`/`child_end`。 |
| HTTP 子代理入口 | `apps/host/src/routes/tool-routes.ts` | 已有 | `/api/subagent/run` 与 `/api/subagent/parallel` 已接入路由，写入/高风险工具会被审批策略挡住。 |
| 确定性办公配方 | `apps/host/src/recipes/run-recipe.ts`、`apps/host/src/recipes/registry.ts` | 已有 | recipes 生成可审批文件操作并写 run record/events。 |
| UI 子任务事件基础 | `apps/windows-client/ui/src/lib/app-logic.test.ts`、`apps/windows-client/ui/src/components/chat/Timeline*` | 部分已有 | 已有 child lifecycle 分组基础，但还不是完整“AI 小队时间线”。 |

### 31.2 当前已落地与仍未落地的 2.5 编排层

以下状态基于 2026-07-05 本轮源码与命令复核；不再使用旧的“orchestrator 目录不存在”结论：

```txt
✅ apps/host/src/orchestrator/ 已存在：types、AgentRegistry、ContextPacker、BudgetManager、GuardrailEngine、ResultSynthesizer、TraceRecorder、WorkflowRunner、weekly-report recipe 已落地。
✅ /api/orchestrator/run 已接入：POST 启动 deterministic P0 weekly-report 编排，要求 Idempotency-Key，写 run record/events JSONL/runs index。
✅ /api/orchestrator/runs/:runId 已接入：按 tenant scoped 读取 run、timeline、tasks、results、artifacts。
✅ /api/orchestrator/runs/:runId/cancel 已接入 P0 边界：同步 completed run 返回 409；async worker 活跃 run 支持 cooperative cancel。
✅ /api/orchestrator/runs/:runId/checkpoint 与 `/resume` 已接入基础能力：checkpoint 脱敏落盘，非终态 checkpoint 可续跑。
✅ AgentDefinition / AgentRegistry 已成为正式运行时 contract，内置 supervisor/researcher/writer/verifier/security_reviewer 以及 office-team 角色 excel_helper/ppt_designer/word_polisher/file_organizer。
✅ ContextPacker / BudgetManager / GuardrailEngine / ResultSynthesizer 已独立实现，并有 focused 测试覆盖。
✅ Verifier / SecurityReviewer 已作为可调度 AgentTask 参与 weekly-report sequential workflow。
✅ WorkflowRunner sequential 已成为 P0 上层状态机，显式 transition 拒绝非法状态跳转。
✅ UI 已有专门 Agent Team Timeline / budget / trust report 摘要视图，仍需后续接真实 worker 与更多 recipe。
✅ 只读 subagent task runner 已接入 ToolRegistry,并拒绝 mutating / requiresApproval / high-risk 工具。
✅ folder-map-reduce 与 office-team recipe 已接入 `/api/orchestrator/run`,并有真实 Host HTTP smoke。
✅ weekly-report 在存在 usable modelConfig 时可走 typed provider adapter；无配置时回落 deterministic P0。folder-map-reduce/office-team 已接只读 subagent adapter；真实 Kimi key smoke 已在用户授权后执行。
✅ async worker/cooperative cancel、typed provider adapter、ProviderChatResult typed parse、map_reduce 真并行调度已实现并本地验证。✅ 当前源码 `build:host`、Tauri `--no-bundle` 构建、完整 NSIS installer bundle、rebuilt sidecar direct smoke、真实 Kimi API smoke、当前 installer 重装、installed smoke 与 WebView/a11y 深验已完成。🟡 生产代码签名、正式 updater endpoint/私钥、clean tag release 复验与发布证据仍未完成。
```

### 31.3 架构修正要求

本计划进入实现前必须先吸收本次审计发现：

```txt
1. Orchestrator 必须是显式状态机,不能继续复制 tool-loop/executor 的“大 option 包 + 多个可变标志位”模式。
2. Provider 和 AgentResult 边界必须 typed parse,不能把 `unknown`/`Record<string, unknown>` 继续扩散到编排层。
3. 新增模块按分层放置:
   - L1: types、agent definition、recipe declaration、pure policy types。
   - L2: workflow runner、context packer、budget manager、trace recorder、checkpoint store。
   - L3: orchestrator routes,只做 HTTP/SSE 适配。
   - UI: 只通过 REST/SSE 读状态,不得 import host 内部模块。
4. 先把 P0 sequential workflow 跑通并测绿,再加 parallel map-reduce;不要横向铺开 P0-P2 半成品。
5. 每个 AgentTask 输入/输出都要有 schema,并把 schema 失败作为显式失败事件写入 events.jsonl。
```

### 31.4 P0 实施验收命令

P0 真正完成时，至少要有以下本地证据。没跑过就只能标“待验收”：

```bash
node scripts/run-host-node.mjs --cwd apps/host -- --test --import ../../scripts/test-setup.ts "test/orchestrator-routes.test.ts" "test/orchestrator-runtime.test.ts"
node scripts/run-host-node.mjs scripts/smoke-orchestrator-weekly-report.ts
npm --prefix apps/windows-client/ui run test -- agent-team-timeline AgentTeamTimeline AppContextRail
node scripts/run-host-node.mjs --cwd apps/host -- --test --import ../../scripts/test-setup.ts "test/agent-stream-input.test.ts" "test/tool-loop-context.test.ts"
npm --prefix apps/windows-client/ui run test -- src/lib/model-highlights.test.ts src/lib/chat-stream-callbacks.test.ts src/lib/api.test.ts src/lib/app-logic.test.ts src/components/SettingsTabsContent.test.tsx
npm run check:host-types
npm run check:script-types
npm run check
python -X utf8 scripts\quality_gate.py --level full
npm run build:host
cargo tauri build --no-bundle --ci
cargo tauri build --ci --bundles nsis
# NSIS installer: apps/windows-client/src-tauri/target/release/bundle/nsis/Agent Cowork_0.2.0_x64-setup.exe
# current-sidecar direct smoke report: reports/windows-client-smoke/current-sidecar-smoke-20260705T085841Z.json
```

当前 `smoke-orchestrator-office-team.ts`、`smoke-orchestrator-map-reduce.ts`、`smoke-orchestrator-ppt-from-folder.ts` 与 `smoke-orchestrator-summary-cache.ts` 已存在并通过真实 Host HTTP smoke；UI Agent Team Timeline 已有 view/component focused tests，但尚无专门 Playwright smoke，不得用后端 smoke 代替桌面/前端验收。

本仓库已有 `scripts/quality_gate.py`，生产验收必须跑项目真实 full gate；只跑 focused tests 只能说明本地 P0 切片通过。

### 31.5 当前完成判定

```txt
计划文档状态：已更新为当前可执行交接版。
代码实现状态：2.5 P0/P1 后端 Orchestrator Runtime + controlled handoff MVP + UI Agent Team Timeline 已实现；后端通过 focused tests + weekly-report/map-reduce/office-team/ppt-from-folder HTTP smoke，UI 通过 focused typecheck/vitest。
可继承底座：subagent / subagent-parallel / AgentParallel / recipes / run events 已存在,新 orchestrator 已作为独立 L2 runtime 接上 L3 route,并能通过只读 subagent adapter 调 ToolRegistry。
下一步最小实现：接入生产代码签名、正式 updater endpoint/私钥、clean tag release 复验与发布证据；真实 Kimi provider key smoke、当前 NSIS installer 重装、installed smoke 与 WebView/a11y 深验已在用户授权后完成。
禁止误称：不要说“2.5 多 Agent 产品已上线/生产完成”。准确说法是“2.5 本地编排闭环已实现 typed provider adapter、ProviderChatResult typed parse、只读 subagent worker、office/map-reduce/ppt-from-folder recipe、checkpoint/resume、async cooperative cancel、map_reduce 真并行调度、controlled handoff MVP、文件摘要缓存、UI Timeline、模型标注和 context compaction,并通过本地门禁；当前源码桌面 no-bundle 构建、完整 NSIS installer bundle、sidecar direct smoke、真实 Kimi provider smoke、当前 installer 重装、installed smoke 与 WebView/a11y 深验已过；但上线/生产验收仍缺生产代码签名、正式 updater 发布链、clean tag release 复验与发布证据”。
```

---

## 32. 当前来源验证

- 本地架构/代码复核:2026-07-05 读取 `plan/00-架构基线与模块依赖.md`、`apps/host/src/runtime/subagent.ts`、`apps/host/src/runtime/subagent-parallel.ts`、`apps/host/src/kimi/agent/parallel-agent-tool.ts`、`apps/host/src/routes/tool-routes.ts`、`apps/host/src/recipes/run-recipe.ts`、`apps/host/src/recipes/registry.ts`、`apps/host/src/orchestrator/*`、`apps/host/src/routes/orchestrator-routes.ts`、`apps/host/src/routes/orchestrator-route-support.ts`。
- 本地搜索证据:2026-07-05 运行 `rg --files apps\host\src | rg "orchestrator|subagent|agent-parallel|parallel|workflow|recipe"`,确认已有 subagent/recipes,且本轮已新增 `apps/host/src/orchestrator/` 与 `/api/orchestrator/*` route 支持。
- 本地编排验证:2026-07-05 运行 focused orchestrator tests 22 passed、focused provider/orchestrator adapter tests 35 passed、`npm run check` passed、`git diff --check` passed；controlled handoff 新增后已重跑 `npm run check:host-types`、`npm run check:host-test-types`、`npm run check:script-types`、office-team/ppt-from-folder 真实 Host HTTP smoke 与 `python -X utf8 scripts\quality_gate.py --level full` passed；orchestrator smoke 证据包括 `output/smoke/orchestrator-weekly-report.json`、`output/smoke/orchestrator-map-reduce.json`、`output/smoke/orchestrator-office-team.json`、`output/smoke/orchestrator-ppt-from-folder.json`、`output/smoke/orchestrator-summary-cache.json`、`output/smoke/orchestrator-resume.json`、`output/smoke/orchestrator-async-cancel.json`。
- 当前源码桌面构建/sidecar/installer 验证:2026-07-05 `npm run build:host` passed,刷新 Tauri sidecar 二进制;`cargo tauri build --no-bundle --ci` passed,`prepare-embedded-python.ps1` staging Python 3.12.10 成功;用户授权收口后 `npm --prefix apps/windows-client/ui run build`、`npm run build:host`、`cargo tauri build --ci --bundles nsis` 再次 passed,生成 `apps/windows-client/src-tauri/target/release/bundle/nsis/Agent Cowork_0.2.0_x64-setup.exe`,大小 79,222,537 bytes,SHA256 `9B19D12DD00A3DAC9A86C78D3FF01BCD83F02F16EFBDF9CF880DDC0784D5D6A5`,Authenticode `NotSigned`;`reports/windows-client-smoke/current-sidecar-smoke-20260705T085841Z.json` ok=true,独立端口 3998 覆盖 `/health`、guest auth、`/api/kimi/info`、SQLite runtime、embedded Python runtime,并确认端口释放。
- 已安装版验证:2026-07-05 用户授权后用当前 NSIS installer 静默重装,`scripts/smoke-installed-tauri.ps1` passed,证据 `reports/windows-client-smoke/installed-tauri-smoke-20260705T142258Z.json`;installed app 观测 `kimi.configured=true`,provider `kimi-api`,model `kimi-k2.7-code`。installed WebView/a11y smoke passed,证据 `reports/windows-client-smoke/installed-a11y-2026-07-05-142323Z.json`,`viewsScanned=20`,`contrastIssues=0`,`mobileComposerOk=true`,`overflowIssues=[]`。
- 真实 provider smoke:2026-07-05 用户授权后加载 `.env` 运行 `node scripts/run-host-node.mjs scripts/smoke-kimi-api.ts` passed,证据 `build/kimi-api-smoke-report.json`;baseUrl `https://api.moonshot.cn/v1`,model `kimi-k2.7-code`,runId `run_20260705141206_77c6936b`,durationMs 13955。
- UI Agent Team Timeline 验证:2026-07-05 `npm --prefix apps/windows-client/ui run test -- agent-team-timeline AgentTeamTimeline AppContextRail` passed,3 files / 7 tests。
- LangChain Multi-Agent 官方文档: https://docs.langchain.com/oss/python/langchain/multi-agent ,2026-07-05 复核 Subagents/Handoffs/Skills/Router/Custom workflow 与 context engineering。
- Microsoft Agent Framework 官方文档: https://learn.microsoft.com/en-us/agent-framework/overview/ ,2026-07-05 复核 agents vs workflows、type-safe routing、checkpointing、human-in-the-loop。
- AutoGen 迁移官方文档: https://learn.microsoft.com/en-us/agent-framework/migration-guide/from-autogen/ ,2026-07-05 复核 AutoGen 向 Microsoft Agent Framework 的迁移背景。
- OpenAI Agents SDK 官方文档: https://openai.github.io/openai-agents-python/ 与 https://openai.github.io/openai-agents-js/ ,2026-07-05 复核 Agents、Agents as tools/Handoffs、Guardrails、Sessions、Tracing、MCP。
- PydanticAI Multi-Agent 官方文档: https://pydantic.dev/docs/ai/guides/multi-agent-applications/ ,2026-07-05 复核 delegation、programmatic handoff、graph-based control flow、usage limits。


---

## 33. 2026-07-05 收口验证

本计划文件已按当前仓库状态补齐为可执行交接版,但验证结论必须分开写:

```txt
本地可验证项:2.5 P0/P1 编排切片、controlled handoff MVP、文件摘要缓存、模型模态/上下文标注、自动压缩当前对话上下文、真实 Kimi provider smoke、当前 installer 重装、installed smoke 与 WebView/a11y 深验均已通过 focused tests / smoke / full gate 或对应安装版 smoke。
正式 2.5 上线/生产验收:尚未完成,仍缺生产代码签名、正式 updater 发布链、clean tag release 复验与产品化发布证据；typed provider adapter、ProviderChatResult typed parse、async cooperative cancel、map_reduce 真并行调度、ppt-from-folder 受控编排、controlled handoff MVP、文件摘要缓存、checkpoint/resume、模型标注、context compaction、当前源码 no-bundle 构建、完整 NSIS installer bundle、sidecar direct smoke、真实 Kimi provider smoke、installed smoke 与 WebView/a11y 深验已本地验证。
```

本轮本地证据:

```bash
npm --prefix apps/windows-client/ui run test -- src/lib/model-highlights.test.ts
node scripts/run-host-node.mjs --cwd apps/host -- --test --import ../../scripts/test-setup.ts "test/model-provider-catalog.test.ts" "test/model-provider.test.ts"
node scripts/run-host-node.mjs --cwd apps/host -- --test --import ../../scripts/test-setup.ts "test/orchestrator-routes.test.ts" "test/orchestrator-runtime.test.ts"
node scripts/run-host-node.mjs scripts/smoke-orchestrator-weekly-report.ts
node scripts/run-host-node.mjs scripts/smoke-orchestrator-map-reduce.ts
node scripts/run-host-node.mjs scripts/smoke-orchestrator-office-team.ts
node scripts/run-host-node.mjs scripts/smoke-orchestrator-ppt-from-folder.ts
node scripts/run-host-node.mjs scripts/smoke-orchestrator-summary-cache.ts
node scripts/run-host-node.mjs scripts/smoke-orchestrator-resume.ts
node scripts/run-host-node.mjs scripts/smoke-orchestrator-async-cancel.ts
npm --prefix apps/windows-client/ui run test -- agent-team-timeline AgentTeamTimeline AppContextRail
node scripts/run-host-node.mjs --cwd apps/host -- --test --import ../../scripts/test-setup.ts "test/agent-stream-input.test.ts" "test/tool-loop-context.test.ts"
npm --prefix apps/windows-client/ui run test -- src/lib/model-highlights.test.ts src/lib/chat-stream-callbacks.test.ts src/lib/api.test.ts src/lib/app-logic.test.ts src/components/SettingsTabsContent.test.tsx
npm run check:host-types
npm run check:script-types
npm run check
python -X utf8 scripts\quality_gate.py --level full
npm run build:host
cargo tauri build --no-bundle --ci
cargo tauri build --ci --bundles nsis
# NSIS installer: apps/windows-client/src-tauri/target/release/bundle/nsis/Agent Cowork_0.2.0_x64-setup.exe
# current-sidecar direct smoke report: reports/windows-client-smoke/current-sidecar-smoke-20260705T085841Z.json
```

本轮新增结果:

```txt
model provider/orchestrator adapter focused tests:35 tests passed
model metadata stale-default regression test:1 file / 6 tests passed
orchestrator focused tests:22 tests passed
smoke-orchestrator-weekly-report:passed, run record/events/detail verified, evidence output/smoke/orchestrator-weekly-report.json
smoke-orchestrator-map-reduce:passed, subagent runner/detail verified, evidence output/smoke/orchestrator-map-reduce.json
smoke-orchestrator-office-team:passed, subagent runner/detail + controlled handoff 6 events verified, evidence output/smoke/orchestrator-office-team.json
smoke-orchestrator-ppt-from-folder:passed, subagent runner/detail + controlled handoff 5 events verified, evidence output/smoke/orchestrator-ppt-from-folder.json
smoke-orchestrator-summary-cache:passed, FileSummaryCache hit/detail verified, evidence output/smoke/orchestrator-summary-cache.json
smoke-orchestrator-resume:passed, checkpoint/resume/detail verified, evidence output/smoke/orchestrator-resume.json
smoke-orchestrator-async-cancel:passed, provider-backed async cancel/AbortSignal/checkpoint verified, evidence output/smoke/orchestrator-async-cancel.json
agent-stream/context compaction focused tests:passed, 7 tests
model metadata/context compaction UI focused tests:passed, 5 files / 71 tests
check:host-types:passed
check:script-types:passed
repo check:passed
repo diff whitespace check:passed, CRLF warnings only
full quality gate:passed after controlled handoff slice, including security:local-strict, build:ui, smoke:playwright-all, ci, test:host 1019 passed / 1 skipped, test:ui 375 passed, eval 28/28
build:host:passed, refreshed current source sidecar binary for Tauri
cargo tauri build --no-bundle --ci:passed, beforeBuildCommand/embedded Python 3.12.10 staging passed, Cargo PDB filename collision warning only
cargo tauri build --ci --bundles nsis:passed, produced apps/windows-client/src-tauri/target/release/bundle/nsis/Agent Cowork_0.2.0_x64-setup.exe, 79,205,222 bytes, SHA256 47D401D0D75CB4FFB233A23E2941F79313B8D16803B1F3E7D9A93893951BE589, Authenticode NotSigned
current-sidecar direct smoke:passed, evidence reports/windows-client-smoke/current-sidecar-smoke-20260705T085841Z.json, covered health/auth/kimi info/sqlite/python on port 3998 and released the port
true Kimi provider smoke:passed after user authorization, evidence build/kimi-api-smoke-report.json, model kimi-k2.7-code, runId run_20260705141206_77c6936b
current installer reinstall smoke:passed, evidence reports/windows-client-smoke/installed-tauri-smoke-20260705T142258Z.json
installed WebView/a11y smoke:passed, evidence reports/windows-client-smoke/installed-a11y-2026-07-05-142323Z.json, contrastIssues=0, mobileComposerOk=true
```

禁止把上述 local P0/P1 切片通过误写成“2.5 多 Agent 产品完成”。准确状态是:

```txt
Agent Cowork 已有可复用多 Agent 底座。
Agent Cowork 2.5 P0/P1 后端 Orchestrator Runtime 已实现 weekly-report、folder-map-reduce、office-team、ppt-from-folder 本地闭环,其中后两者走只读 subagent adapter。
本轮又补齐 controlled handoff MVP、模型模态/上下文长度标注、自动压缩当前对话上下文与文件摘要缓存的本地闭环。
下一步从生产代码签名、正式 updater 发布链、clean tag release 复验与发布证据开始；真实 provider key smoke、当前 installer 重装、installed/WebView 深验和 controlled handoff MVP 已本地闭合。
```

---

## 34. 2026-07-06 真实 Kimi / 安装版收口验证

用户授权真实 Kimi 验证后,本轮把上一节列为“需授权/待重装/待 WebView 深验”的本地遗留项收口到证据文件:

```txt
证据总表:reports/acceptance-record-20260706-kimi-installed-signing.md
真实 Kimi smoke:build/kimi-api-smoke-report.json,model kimi-k2.7-code,baseUrl https://api.moonshot.cn/v1,runId run_20260705141206_77c6936b
当前 installer:apps/windows-client/src-tauri/target/release/bundle/nsis/Agent Cowork_0.2.0_x64-setup.exe,79,222,537 bytes,SHA256 9B19D12DD00A3DAC9A86C78D3FF01BCD83F02F16EFBDF9CF880DDC0784D5D6A5,Authenticode NotSigned
installed smoke:reports/windows-client-smoke/installed-tauri-smoke-20260705T142258Z.json,ok=true
installed WebView/a11y:reports/windows-client-smoke/installed-a11y-2026-07-05-142323Z.json,ok=true,contrastIssues=0,mobileComposerOk=true
签名/updater:installer、installed desktop、sidecar 均为 NotSigned;TAURI_SIGNING_PRIVATE_KEY/WINDOWS_SIGNING_PFX/KCW_UPDATE_ENDPOINT 等生产变量未配置;createUpdaterArtifacts=false,UPDATES_CONFIGURED=false
```

准确状态:

```txt
本地 Kimi 与安装版验收遗留项已闭合。
生产发布信任链未闭合,需要真实 CA/PFX 或等效签名链、Tauri updater 私钥、正式 HTTPS updater endpoint、clean tag release 复验与发布证据。
```

---

## 35. 2026-07-06 全量 E2E / GitHub 同步前复核

本轮在推送 GitHub 前补跑了全量本地验收、发布 checklist 的 Q6/Q7/Q8、当前源码安装包重建、静默安装、安装版 smoke 和 WebView/a11y 深验:

```txt
full quality gate:passed, command python -X utf8 scripts\quality_gate.py --level full
test:host:1019 passed / 1 skipped
test:ui:375 passed
eval:28/28 passed
smoke:e2e:passed, reports/e2e-smoke/e2e-smoke-2026-07-05T22-05-09-867Z.json
bench:passed, reports/bench/bench-2026-07-05T22-05-09-910Z.json
installed-tauri dry-run:passed, reports/windows-client-smoke/installed-tauri-smoke-20260705T220508Z.json
ui build:passed, npm --prefix apps/windows-client/ui run build
host sidecar build:passed, npm run build:host
NSIS installer build:passed, cargo tauri build --ci --bundles nsis
silent install:passed, installer exit code 0
installed-tauri smoke:passed, reports/windows-client-smoke/installed-tauri-smoke-20260705T220946Z.json
installed WebView/a11y smoke:passed, reports/windows-client-smoke/installed-a11y-2026-07-05-221006Z.json, viewsScanned=20, contrastIssues=0, mobileComposerOk=true
```

最新内部 beta 安装包:

```txt
release copy:releases/Agent-Cowork-Setup-v0.2.0-internal-beta.exe
size:79,218,176 bytes
sha256:5071F9BEBA6B854297911BBBA3F626AAD15D50F55A8D7C61ACD482B10F428A36
sha file:releases/Agent-Cowork-Setup-v0.2.0-internal-beta.exe.sha256
authenticode:NotSigned
```

安装版文件签名状态:

```txt
installed desktop exe:NotSigned, sha256 7D5ADAA9019BE39B10C2014F96409D9AEDABC9D0321128E124DC827DAF59E5C8
installed sidecar exe:NotSigned, sha256 603CCF0B663A94A5918E3D7553D9C313F07DFE1D4896020A0507B6ABF74E4F5C
```

旧安装包清理结果:

```txt
保留:releases/Agent-Cowork-Setup-v0.2.0-internal-beta.exe
保留:releases/Agent-Cowork-Setup-v0.2.0-internal-beta.exe.sha256
删除:releases/v0.1.0 与 releases/v0.2.0 下旧 exe/msi 包体
删除:releases/agent-cowork-v0.2.0-internal-beta-20260705T184445Z.zip 及 sha
删除:releases/internal-beta-v0.2.0-20260705T184445Z 过期包目录
删除:installers/ 下旧 exe/msi 缓存
```

本轮真实 Kimi 复跑边界:

```txt
npm run smoke:kimi-api 在当前 shell 中因未设置 KIMI_API_KEY / MOONSHOT_API_KEY 未执行。
此前用户授权的真实 Kimi evidence 仍为 build/kimi-api-smoke-report.json。
```

准确状态:

```txt
内部 beta 本地可验证项已通过,并已准备推送到 GitHub。
生产上线仍未完成:缺真实受信代码签名、正式 updater endpoint/私钥、clean tag release 与外部发布证据。
```
