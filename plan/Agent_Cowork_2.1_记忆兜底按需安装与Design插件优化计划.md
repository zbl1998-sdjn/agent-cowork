# Agent Cowork 2.1 优化计划：长期记忆、兜底降级、按需安装下载、岗位能力包、缓存命中与 Design 插件

> 版本：v0.1  
> 日期：2026-07-02  
> 目标读者：产品、前端、Host 后端、Agent Runtime、安全、测试  
> 建议文件路径：`docs/Agent-Cowork-2.1-记忆兜底按需安装与Design插件优化计划.md`

---

## 0. 一句话结论

Agent Cowork 下一阶段应从“能完成本地 Agent 任务”升级为 **会记住、会解释、会降级、会按需补能力、会展示上下文来源、会用 Design 插件校验前端编码结果** 的本地优先工作台。

本次优化的产品主线是：

1. **长期记忆内置化**：不再只依赖外部 MASE；内置轻量 MemoryCore，MASE 作为高级/外部 Adapter。
2. **跨窗口/跨会话总结**：新窗口能读取同一项目、同一工作区、同一用户允许范围内的历史摘要、偏好、事实和最近任务进展。
3. **可见、可控、可删除的记忆**：像 Claude 一样让用户看到“记住了什么”，并支持暂停、隐身、删除、导出、导入。
4. **缓存命中优化**：本地文件解析、记忆召回、上下文拼装、模型请求前缀、工具结果、依赖下载都要缓存，并在 UI 显示命中情况。
5. **兜底降级体系**：模型不可用、记忆不可用、依赖缺失、Docker 不可用、网络不可用、权限不足时，不阻塞主流程，而是明确降级并给用户下一步按钮。
6. **按需安装下载**：核心包保持轻量；不同岗位通过 Role Pack / Capability Pack 自行安装，所有下载必须可审计、可验证、可卸载。
7. **Coding 必须使用 Design 插件**：涉及前端 UI/UX 的编码任务，必须先生成设计上下文，再改代码，再做截图/视觉验证，形成“设计 → 代码 → 验收”闭环。

---

## 1. 当前项目基础与这次改造边界

当前 Agent Cowork 已具备以下基础能力，可作为 2.1 的承接点：

- Agentic tool-calling loop、Plan Mode、MCP、审批、审计、trusted root jail、SSRF 守卫、JWT、安全脱敏、`shell:false`。
- 双存储后端：SQLite / PostgreSQL。
- 可选 MASE 长期记忆桥接：每轮开始注入最近对话、结构化事实、跨会话相关历史；每轮结束写回并抽取事实；召回超时则安全降级。
- 前端已有任务卡片、执行动态、产物面板、React smoke、滚动 smoke、connector smoke、artifact smoke。
- Kimi API 计划生成、runs 记录、artifact / audit 落盘。
- sandbox 已有 Docker / LocalSubprocess 选择与网络隔离提示。

本次不推翻现有架构，而是在现有 Host / UI / Agent Runtime 上新增 5 个中台：

```txt
MemoryCore        记忆中台
FallbackEngine    兜底降级中台
CapabilityCenter  能力包/岗位包安装中心
CacheService      本地缓存与模型缓存提示中台
DesignPlugin      前端编码设计插件与视觉验收中台
```

---

## 2. 外部产品参考：只借鉴机制，不照搬品牌

### 2.1 Claude 记忆参考

Claude 当前公开说明中的记忆设计重点包括：

- 记忆偏向工作相关上下文，如用户角色、项目、专业背景、沟通偏好、编码风格、项目细节和持续工作。
- 用户可以查看和编辑 Claude 的记忆摘要，也可以在聊天里告诉 Claude 更新记忆。
- 用户可以暂停记忆、重置记忆、使用 incognito chat 排除记忆。
- Cowork 项目记忆按项目作用域隔离，一个项目学到的内容不会自动带到另一个项目。
- Claude Code 有 repo 级自动记忆，会把偏好、纠正和模式保存到项目相关目录；同时 `CLAUDE.md` 继续作为手工维护的团队/项目规则。

对 Agent Cowork 的启发：

```txt
记忆必须可见、可控、可作用域隔离。
记忆不能只是向量库，而要同时支持：事实、偏好、项目摘要、纠错规则、任务进展、安装能力、设计规则。
```

### 2.2 Kimi / Moonshot 参考

Kimi 侧值得参考两点：

1. Kimi 产品线强调 Agent、Skills、Claw / 多 Agent、文档/表格/幻灯片/网站产出等“结果导向”能力。
2. Kimi API 的 `prompt_cache_key` 字段用于缓存相似请求，编码 Agent 通常使用 session id 或 task id，退出后恢复同一会话仍应保持相同 key，以提高缓存命中率。

对 Agent Cowork 的启发：

```txt
记忆不是单独功能，而要和任务、技能、产物、缓存、模型路由绑定。
缓存 key 不能随便生成，要围绕 projectId / taskId / sessionId / providerId 稳定设计。
```

### 2.3 Claude Design / Claude Code 插件参考

Claude Design 公开说明中有几个关键点值得借鉴：

- onboarding 阶段读取代码库和设计文件，构建团队设计系统。
- 支持从文本、图片、文档、代码库、网页捕获等来源导入。
- 支持细粒度调整，如元素评论、文本直接编辑、间距/颜色/布局调节。
- 设计完成后生成 handoff bundle，交给 Claude Code 实现。
- Claude Code 插件可包含 skills、agents、hooks、MCP servers、LSP servers，并通过 marketplace 分发。

对 Agent Cowork 的启发：

```txt
前端编码不能只看代码 diff，还要看设计上下文、设计 token、组件约束、截图结果和验收标准。
```

---

## 3. 产品定位升级

### 3.1 新定位

> Agent Cowork 是一个本地优先的职业工作台。它能记住你怎么工作，能按岗位补齐需要的工具库，能在能力不足时明确降级，并能把每次任务的上下文、记忆、缓存、工具、产物和风险展示给用户。

### 3.2 目标用户场景

| 用户岗位 | 需要的核心能力 | 不应默认打包 | 建议按需安装 |
|---|---|---|---|
| 开发者 | 代码理解、重构、测试、前端视觉验收、LSP | 所有语言 LSP、所有浏览器、所有测试框架 | Coding Pack、Frontend Design Pack、LSP Pack |
| 产品经理 | PRD、竞品分析、会议纪要、路线图 | OCR、大型数据处理、所有 Office 转换库 | PM Pack、Docs Pack、Slides Pack |
| 设计/运营 | 文案、活动页、视觉草稿、截图对比 | Playwright 浏览器、图像处理库 | Design Pack、Web Capture Pack |
| 法务/合同 | 合同抽取、风险清单、条款比对 | 法律行业词库、OCR、PDF 表格抽取 | Legal Pack、PDF OCR Pack |
| 财务/数据 | Excel、CSV、报表、公式校验 | pandas、duckdb、pyarrow、大型依赖 | Data Analysis Pack、Spreadsheet Pack |
| HR/行政 | 简历筛选、制度问答、模板文档 | 简历解析器、OCR、邮件连接器 | HR Pack、Docs Pack |
| 销售/客服 | 客户跟进、话术、CRM 摘要 | CRM connector、邮件/IM connector | Sales Pack、CRM Connector Pack |

---

## 4. 总体架构

```txt
┌──────────────────────────────────────────────────────────────┐
│                         React / Tauri UI                     │
│  Memory Panel | Install Center | Cache Monitor | Fallback Bar │
│  Design Review | Task Center | Context Stack | Settings       │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                           Host API                            │
│ /api/memory/* | /api/cache/* | /api/capabilities/*             │
│ /api/install/* | /api/fallback/* | /api/design/*               │
└───────┬─────────────┬──────────────┬──────────────┬───────────┘
        │             │              │              │
┌───────▼──────┐ ┌────▼──────┐ ┌─────▼──────┐ ┌────▼───────────┐
│ MemoryCore   │ │ CacheSvc  │ │ Installer  │ │ FallbackEngine │
│ SQLite/PG    │ │ LRU/TTL   │ │ Packs      │ │ Degrade Matrix │
│ FTS/Vector   │ │ Provider  │ │ Manifest   │ │ Retry/Resume   │
└───────┬──────┘ └────┬──────┘ └─────┬──────┘ └────┬───────────┘
        │             │              │              │
        └─────────────┴──────┬───────┴──────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│                      Agent Runtime                           │
│ Plan Mode | ModelRouter | ToolRegistry | MCP | Hooks          │
│ DesignPlugin | Skills | Recipes | Subagents | Audit/Rollback  │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│               Local Files / Workspace / Artifacts            │
│ .AgentCowork/memory | .AgentCowork/cache | .AgentCowork/packs │
│ .AgentCowork/runs | .AgentCowork/audit | .AgentCowork/design  │
└──────────────────────────────────────────────────────────────┘
```

### 4.1 五个新增中台职责

| 中台 | 职责 | 默认是否启用 |
|---|---|---|
| MemoryCore | 长期记忆、跨窗口摘要、事实抽取、召回、用户可控管理 | 是，轻量内置 |
| CacheService | 文件解析缓存、记忆召回缓存、上下文拼装缓存、模型缓存 key | 是 |
| FallbackEngine | 统一兜底策略、降级状态、恢复建议、重试与恢复 | 是 |
| CapabilityCenter | 能力包目录、依赖解析、下载、校验、安装、卸载 | 是，但不自动安装重依赖 |
| DesignPlugin | 前端 UI 编码的设计上下文、截图验证、设计交付包 | 基础版内置，浏览器截图能力按需安装 |

---

## 5. 长期记忆优化计划

### 5.1 目标

当前 MASE 桥接是可选能力，但它依赖外部仓库、外部 Python 环境，并且启用门槛较高。2.1 应把“记忆”升级为产品核心能力：

```txt
默认可用：内置轻量 MemoryCore，不需要外部 MASE。
高级可插拔：MASE、企业知识库、向量库作为 Memory Adapter。
跨窗口可用：不同窗口、不同会话能读取同一项目/用户范围内的摘要。
可见可控：用户能看到、编辑、删除、暂停、导出。
安全默认：不自动记住密钥、身份证、健康、财务账号、API Key、token。
```

### 5.2 记忆层级设计

```txt
L0 Active Turn Buffer
  当前窗口最近 N 轮原始消息，短期上下文，不长期保存全部内容。

L1 Thread Rolling Summary
  单个对话线程的滚动摘要，用于窗口重开和上下文压缩。

L2 Project Memory
  项目级记忆：项目目标、约束、技术栈、当前进展、未完成事项、常用命令。

L3 Workspace Memory
  工作区级记忆：文件结构、重要目录、产物位置、数据源说明。

L4 User Profile Memory
  用户偏好：语言、格式、沟通风格、常用模型、审批偏好、保密偏好。

L5 Job Role Memory
  岗位相关偏好：开发/产品/法务/财务/运营等不同角色的工作模板和库选择。

L6 Structured Facts
  结构化事实：我的项目叫 X、客户叫 Y、默认用 pnpm、不要改某目录。

L7 Correction / Negative Memory
  纠错记忆：不要再做 X；这类任务必须先问/先查/先走某流程。

L8 Artifact Memory
  产物记忆：上次生成的报告、PPT、表格、代码补丁、审计记录位置和摘要。

L9 Capability Memory
  已安装能力包、已失败依赖、用户拒绝过的安装、岗位推荐情况。
```

### 5.3 MemoryCore 数据模型

建议新增目录：

```txt
apps/host/src/memory-core/
  memory-core.ts
  memory-store.ts
  memory-policy.ts
  memory-extractor.ts
  memory-summarizer.ts
  memory-retriever.ts
  memory-ranker.ts
  memory-cache.ts
  memory-redactor.ts
  memory-ui-dto.ts
  adapters/
    sqlite-memory-adapter.ts
    postgres-memory-adapter.ts
    mase-memory-adapter.ts
    vector-memory-adapter.ts
```

建议 SQLite 表：

```sql
CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  user_id TEXT NOT NULL DEFAULT 'local-user',
  project_id TEXT,
  workspace_id TEXT,
  thread_id TEXT,
  scope TEXT NOT NULL, -- user | project | workspace | thread | role | org
  kind TEXT NOT NULL,  -- preference | fact | summary | correction | artifact | capability | warning
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  normalized_key TEXT,
  confidence REAL NOT NULL DEFAULT 0.7,
  sensitivity TEXT NOT NULL DEFAULT 'normal', -- public | normal | sensitive | secret
  source_run_id TEXT,
  source_message_id TEXT,
  source_artifact_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);

CREATE TABLE memory_summaries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  user_id TEXT NOT NULL DEFAULT 'local-user',
  project_id TEXT,
  workspace_id TEXT,
  thread_id TEXT,
  summary_type TEXT NOT NULL, -- thread | project | workspace | user | role
  content TEXT NOT NULL,
  source_range_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE memory_events (
  id TEXT PRIMARY KEY,
  item_id TEXT,
  event_type TEXT NOT NULL, -- create | update | merge | use | hide | delete | export | import
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE memory_embeddings (
  item_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  embedding_hash TEXT NOT NULL,
  vector BLOB,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_memory_scope ON memory_items(user_id, project_id, workspace_id, scope, kind, enabled);
CREATE INDEX idx_memory_key ON memory_items(user_id, normalized_key, kind, enabled);
CREATE INDEX idx_memory_recent ON memory_items(user_id, updated_at, last_used_at);
```

可选 FTS：

```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(
  title,
  content,
  kind,
  scope,
  content='memory_items',
  content_rowid='rowid'
);
```

### 5.4 写入流程：从“每轮写日志”升级为“可审计记忆提炼”

```txt
用户/助手一轮完成
  ↓
MemoryCandidateExtractor
  ↓
SensitivityClassifier
  ↓
MemoryPolicyDecision
  ├─ allow_auto_write
  ├─ require_user_confirm
  ├─ write_thread_only
  ├─ redact_then_write
  └─ deny_write
  ↓
ConflictResolver
  ↓
MemoryStore.upsert
  ↓
SummaryUpdater
  ↓
CacheInvalidator
  ↓
MemoryEvent audit
```

### 5.5 记忆候选规则

默认自动写入：

```txt
- 明确偏好：以后都用中文；代码示例用 TypeScript；不要使用某库。
- 项目事实：这个项目使用 React + Tauri；workspace 是某目录。
- 纠错规则：刚才的路径错了，正确路径是 X。
- 工作进展：已生成 PRD v2；下一步是模型适配。
- 能力配置：用户安装了 Data Analysis Pack；拒绝安装 OCR Pack。
```

必须确认后写入：

```txt
- 与身份、公司、客户、合同、薪酬、财务、医疗、法律风险高度相关的事实。
- 可能影响未来行为的强规则：永远不要联网、自动批准所有写操作等。
- 跨项目生效的偏好。
```

禁止写入：

```txt
- API Key、token、密码、私钥、cookie、session。
- 完整身份证、银行卡、手机号、邮箱列表等不必要敏感信息。
- 用户未明确授权的私密聊天内容。
- 隐身模式下的任何长期记忆。
```

### 5.6 召回流程：跨窗口但不串项目

```txt
新窗口 / 新任务开始
  ↓
Resolve Context Scope
  ├─ user_id
  ├─ project_id
  ├─ workspace_id
  ├─ thread_id
  ├─ role_profile
  └─ security_mode
  ↓
MemoryRetriever
  ├─ exact key match
  ├─ project summary
  ├─ workspace summary
  ├─ recent thread summary
  ├─ FTS keyword recall
  ├─ optional vector recall
  └─ artifact/run recall
  ↓
MemoryRanker
  ↓
Budgeted Injection
  ↓
Context Stack UI
```

召回分数建议：

```ts
score =
  0.30 * scopeMatch +
  0.25 * semanticSimilarity +
  0.15 * keywordMatch +
  0.10 * recency +
  0.10 * confidence +
  0.05 * userPinned +
  0.05 * lastUsedBoost -
  sensitivityPenalty -
  stalePenalty
```

注入预算建议：

| 场景 | 记忆注入预算 | 策略 |
|---|---:|---|
| 普通聊天 | 800-1500 tokens | 用户偏好 + 相关事实 + 最近项目摘要 |
| 项目任务 | 2000-5000 tokens | 项目摘要 + 任务进展 + 相关产物 |
| 代码任务 | 2000-8000 tokens | 技术栈 + 纠错记忆 + 常用命令 + 设计约束 |
| 法务/财务敏感任务 | 1000-3000 tokens | 最小必要事实，敏感内容需确认 |
| Local Strict | 不限制云出站，但仍控制上下文长度 | 全本地模型可注入更多，但仍要可解释 |

### 5.7 记忆跨窗口总结策略

每个窗口不直接共享整段聊天，而共享“摘要 + 事实 + 任务状态”：

```txt
Window A 完成任务
  ↓
更新 ThreadSummary
  ↓
更新 ProjectSummary
  ↓
写入 ArtifactMemory
  ↓
广播 MemoryUpdatedEvent
  ↓
Window B 下次发送前读取最新 MemorySnapshot
```

`MemorySnapshot` 示例：

```ts
type MemorySnapshot = {
  userPreferences: MemoryItem[]
  projectSummary?: string
  workspaceSummary?: string
  recentProgress: MemoryItem[]
  correctionRules: MemoryItem[]
  artifactHints: MemoryItem[]
  capabilityState: InstalledCapability[]
  omitted: Array<{ reason: string; count: number }>
}
```

### 5.8 UI：记忆必须前端可见

新增“记忆”一级面板，建议分 5 个 tab：

```txt
记忆
  ├─ 本次使用
  │   ├─ 引用了哪些记忆
  │   ├─ 为什么引用
  │   ├─ 来源 run / 对话 / 产物
  │   └─ 对本次回答的影响
  ├─ 项目记忆
  │   ├─ 项目目标
  │   ├─ 技术栈
  │   ├─ 进行中任务
  │   └─ 注意事项
  ├─ 我的偏好
  │   ├─ 沟通风格
  │   ├─ 编码风格
  │   ├─ 文件输出偏好
  │   └─ 安全偏好
  ├─ 纠错规则
  │   ├─ 不要再犯
  │   ├─ 必须遵守
  │   └─ 待确认规则
  └─ 管理
      ├─ 暂停记忆
      ├─ 隐身模式
      ├─ 导出
      ├─ 导入
      ├─ 重置项目记忆
      └─ 重置全部记忆
```

每条记忆卡片：

```txt
标题：默认使用 pnpm 而不是 npm
范围：项目级
类型：编码偏好
来源：2026-07-02 · run_abc123 · 用户明确说明
置信度：高
最近使用：刚刚
状态：启用
操作：[编辑] [停用] [删除] [固定] [查看来源]
```

### 5.9 记忆安全策略

核心规则：

```txt
1. 隐身模式不读旧记忆，也不写新记忆。
2. 暂停记忆：保留现有记忆，但本轮不读、不写。
3. 删除对话后，相关记忆候选必须失效或标记为需要重新合成。
4. 导出必须包含 memory_items、memory_summaries、memory_events 的可读版本。
5. 云模型参与记忆摘要时，必须先过 redaction；Local Strict 下只能用本地模型总结。
6. 记忆写入审计必须记录：谁写入、何时写入、从哪条消息/哪个 run 来、是否被用户确认。
```

---

## 6. 兜底降级优化计划

### 6.1 目标

Agent Cowork 的核心卖点不能因为某个模型、依赖、网络、Docker、记忆后端失败就“全局不可用”。2.1 要建立统一 `FallbackEngine`：

```txt
遇到失败时：
- 不中断 UI
- 明确告诉用户降级原因
- 自动切换到安全可用路径
- 保留任务和审计
- 给出一键修复/安装/重试按钮
```

### 6.2 兜底矩阵

| 故障类型 | 检测方式 | 默认兜底 | UI 展示 |
|---|---|---|---|
| 主模型不可用 | timeout / 429 / 5xx / auth fail | 切备用 provider；无备用则本地 planner 生成只读计划 | “模型不可用，已降级为本地计划模式” |
| 云模型被安全策略阻止 | SecurityPolicy deny | 切本地模型；无本地则只做文件分析和人工计划 | “Local Strict 禁止外发上下文” |
| 记忆后端超时 | 2s-2.5s hard timeout | 本轮不带长期记忆，只带当前窗口短期上下文 | “记忆召回超时，未阻塞对话” |
| 依赖包缺失 | Tool capability probe fail | 提供安装按钮；未安装前使用低能力实现 | “需要 PDF OCR Pack 才能识别扫描件” |
| Docker 不可用 | sandbox info | 回退 LocalSubprocess，但明确网络不隔离 | “本地执行不隔离网络，请谨慎批准命令” |
| 网络不可用 | DNS/connectivity probe | 离线模式；禁用 marketplace/云模型/WebFetch | “当前离线，仅使用本地能力” |
| 文件解析失败 | parser exception | 回退纯文本抽取 / 文件摘要 / 用户手动选择片段 | “无法解析复杂格式，已降级为文本提取” |
| 上下文超预算 | token estimator | 摘要压缩 + TopK 召回 + 产物引用而非全文注入 | “已压缩上下文，保留关键记忆” |
| 缓存损坏 | checksum mismatch | 丢弃缓存并重建 | “缓存已重建” |
| SSE 断连 | client reconnect | Last-Event-ID 恢复；任务继续从 run 状态读取 | “连接恢复中，任务未丢失” |
| 安装失败 | checksum / permission / lock | 回滚安装、保留失败日志、提供离线包导入 | “安装未完成，已回滚” |

### 6.3 FallbackEngine 类型设计

```ts
type FallbackCause =
  | 'model_timeout'
  | 'model_auth_failed'
  | 'model_rate_limited'
  | 'memory_timeout'
  | 'memory_disabled'
  | 'dependency_missing'
  | 'sandbox_unavailable'
  | 'network_unavailable'
  | 'policy_denied'
  | 'cache_corrupt'
  | 'parser_failed'
  | 'context_over_budget'
  | 'ui_stream_disconnected'

type FallbackDecision = {
  cause: FallbackCause
  severity: 'info' | 'warning' | 'critical'
  mode: 'continue' | 'degrade' | 'pause_for_user' | 'abort_safely'
  userMessage: string
  technicalMessage: string
  suggestedActions: Array<{
    id: string
    label: string
    kind: 'retry' | 'install' | 'configure' | 'open_settings' | 'switch_provider' | 'continue_degraded'
  }>
  audit: boolean
}
```

### 6.4 UI：兜底状态条

在任务动态区域顶部新增 “能力状态条”：

```txt
当前能力：🟡 混合可控 · 模型 DeepSeek · 记忆已启用 · OCR 未安装 · Docker 不可用

降级提示：PDF 扫描页无法 OCR，已使用文本页摘要。安装 PDF OCR Pack 可提升效果。
[安装 PDF OCR Pack] [继续当前任务] [查看详情]
```

任务详情页新增 `Degradation Timeline`：

```txt
10:02:11  模型调用超时，重试 1/2
10:02:13  切换到备用模型 qwen-plus
10:02:14  记忆召回命中 6 条
10:02:20  OCR Pack 未安装，跳过扫描图片页
10:02:31  生成报告完成
```

---

## 7. 按需安装下载与岗位能力包

### 7.1 目标

不要把所有依赖打进主包。主包只包含：

```txt
- 基础 UI
- Host API
- 文件读写与审批
- 轻量 MemoryCore
- ModelRouter
- 基础 Markdown / 文本 / JSON / CSV 处理
- 插件/能力包安装中心
- 基础 DesignPlugin 协议
```

其余按用户岗位和任务需求安装。

### 7.2 能力包分类

```txt
Capability Pack：面向能力，如 PDF OCR、Office、Browser、Data Analysis、LSP。
Role Pack：面向岗位，如 Developer、PM、Legal、Finance、HR、Sales。
Connector Pack：面向外部系统，如 GitHub、飞书、企业微信、钉钉、Notion、Jira。
Model Pack：面向本地模型，如 Ollama 配置、embedding 模型、reranker。
Design Pack：面向前端/设计，如 browser screenshot、design token、视觉回归。
```

### 7.3 首批能力包建议

| Pack | 作用 | 重依赖 | 默认安装 |
|---|---|---|---|
| `core-text-pack` | Markdown / TXT / JSON / CSV | 无 | 是 |
| `office-pack` | DOCX / PPTX / XLSX 读写增强 | OOXML / zip / xml | 否 |
| `pdf-pack` | PDF 解析、页码引用、轻量生成 | pdf parser | 否 |
| `pdf-ocr-pack` | 扫描件 OCR | OCR 引擎 / 图像库 | 否 |
| `data-analysis-pack` | CSV/Excel 分析、DuckDB、本地统计 | duckdb / pandas 等 | 否 |
| `browser-automation-pack` | Playwright 截图、网页交互 smoke | Chromium/Edge driver | 否 |
| `frontend-design-pack` | 设计 token、组件扫描、截图对比 | browser pack / image diff | 否 |
| `lsp-typescript-pack` | TS/React 代码智能 | TypeScript LSP | 否 |
| `lsp-python-pack` | Python 代码智能 | pyright/ruff 等 | 否 |
| `legal-contract-pack` | 合同抽取 schema、条款风险模板 | 可依赖 pdf/ocr | 否 |
| `finance-report-pack` | 财务表格校验、报表模板 | data-analysis | 否 |
| `pm-docs-pack` | PRD、路线图、会议纪要模板 | office/slides 可选 | 否 |
| `hr-resume-pack` | 简历解析、候选人对比 | pdf/ocr 可选 | 否 |
| `sales-crm-pack` | 客户摘要、跟进计划 | connector 可选 | 否 |
```

### 7.4 Pack Manifest Schema

```ts
type CapabilityPackManifest = {
  schemaVersion: 'agent-cowork.pack.v1'
  id: string
  name: string
  version: string
  description: string
  category: 'capability' | 'role' | 'connector' | 'model' | 'design'
  publisher: string
  homepage?: string
  license: string
  sizeBytes?: number
  capabilities: string[]
  dependencies: Array<{
    type: 'npm' | 'python' | 'binary' | 'docker-image' | 'model' | 'mcp-server' | 'pack'
    name: string
    versionRange?: string
    optional?: boolean
    platform?: Array<'win32' | 'darwin' | 'linux'>
  }>
  permissions: Array<{
    kind: 'filesystem' | 'network' | 'shell' | 'model' | 'mcp' | 'credential'
    scope: string
    reason: string
    default: 'deny' | 'ask' | 'allow'
  }>
  artifacts: Array<{
    url: string
    sha256: string
    signature?: string
    platform?: string
  }>
  install: {
    preflight: string[]
    steps: string[]
    healthcheck: string[]
    uninstall: string[]
  }
  ui: {
    icon?: string
    tags: string[]
    recommendedForRoles: string[]
    screenshots?: string[]
  }
  security: {
    sbomUrl?: string
    signed: boolean
    sandboxRequired: boolean
    networkDuringRuntime: 'none' | 'ask' | 'required'
  }
}
```

### 7.5 安装流程

```txt
用户触发任务
  ↓
CapabilityResolver 检测缺口
  ↓
InstallPlan 生成安装计划
  ↓
用户审批
  ↓
Downloader 下载到 .AgentCowork/downloads
  ↓
ChecksumVerifier / SignatureVerifier
  ↓
SandboxInstaller
  ↓
HealthProbe
  ↓
CapabilityRegistry 启用
  ↓
MemoryCore 记住“用户已安装/拒绝/失败”
```

### 7.6 离线安装

必须支持企业/保密环境：

```txt
- 在线机器下载 `.acpack` 离线包。
- 离线机器导入 `.acpack`。
- Host 校验 sha256、签名、manifest、SBOM。
- 不访问公网也能安装。
- 所有安装记录写入 `.AgentCowork/audit/install.jsonl`。
```

`.acpack` 结构：

```txt
pdf-ocr-pack-1.2.0.acpack
  manifest.json
  sbom.spdx.json
  checksums.txt
  signatures/
  payload/
    win32-x64/
    linux-x64/
  docs/
    README.md
    SECURITY.md
```

### 7.7 UI：安装中心

新增“能力中心”：

```txt
能力中心
  ├─ 推荐给你
  │   ├─ 根据岗位
  │   ├─ 根据当前任务
  │   └─ 根据缺失能力
  ├─ 已安装
  ├─ 可安装
  ├─ 离线导入
  ├─ 安装历史
  └─ 安全与权限
```

推荐卡片示例：

```txt
Frontend Design Pack
适合：前端开发、UI 调整、页面重构
将安装：browser-automation-pack、image-diff、design-token-scanner
需要权限：读取当前 workspace、启动本地浏览器截图
不会做：不会自动上传截图，不会自动改代码
[查看安装计划] [安装]
```

---

## 8. 缓存命中优化计划

### 8.1 缓存目标

```txt
1. 同一项目重复任务更快。
2. 同一文件未变化不重复解析。
3. 同一记忆查询不重复检索和排序。
4. 同一模型会话尽量复用 provider-side cache。
5. 同一能力包不重复下载。
6. 缓存命中/未命中在 UI 可见，便于用户理解速度和成本。
```

### 8.2 缓存类型

| 缓存 | Key | Value | 失效条件 |
|---|---|---|---|
| File Parse Cache | `fileSha256 + parserVersion` | 文本、页码、表格、摘要 | 文件 hash 变化、parser 升级 |
| File Summary Cache | `fileSha256 + summaryModel + promptVersion` | 文件摘要 | 文件变化、模型/提示版本变化 |
| Workspace Index Cache | `workspaceId + treeHash` | 文件树、重要文件、语言统计 | 文件树变化 |
| Memory Recall Cache | `queryHash + scopeHash + memoryVersion` | TopK 记忆 | 记忆新增/编辑/删除 |
| Context Bundle Cache | `taskIntent + projectId + contextVersion` | 拼装后的上下文包 | 记忆/文件/技能变化 |
| Tool Result Cache | `toolName + inputHash + permissionScope` | 只读工具结果 | TTL / 文件变化 |
| Provider Prompt Cache | `providerId + projectId + threadId/taskId` | `prompt_cache_key` 等字段 | 会话结束策略 / 用户清理 |
| Download Cache | `packId + version + sha256` | `.acpack` / binary | checksum 不符 / 清理 |
| Design Snapshot Cache | `route + gitSha + viewport + designPackVersion` | screenshot / diff | 前端代码变化 |
| Embedding Cache | `textHash + embeddingModel` | vector | 模型变化 |

### 8.3 provider-side cache 策略

新增 `ModelCacheHints`：

```ts
type ModelCacheHints = {
  promptCacheKey?: string
  stablePrefixHash: string
  sessionId: string
  taskId?: string
  projectId?: string
  threadId?: string
  keepReasoning?: boolean
}
```

对 Kimi：

```ts
const kimiExtraBody = {
  prompt_cache_key: `${tenantId}:${projectId}:${threadId || taskId}`,
  safety_identifier: sha256(userId).slice(0, 32)
}
```

通用策略：

```txt
- system prompt、项目规则、skills index、design rules 放在稳定前缀。
- 当前用户输入、动态文件片段、实时工具结果放在后缀。
- 同一项目/线程使用稳定 taskId/threadId。
- 不要把随机 runId 放进 prompt 前缀。
- cache key 不包含明文用户名、邮箱、客户名。
```

### 8.4 本地缓存目录

```txt
.AgentCowork/cache/
  file-parse/
  file-summary/
  memory-recall/
  context-bundle/
  tool-results/
  downloads/
  design-snapshots/
  embeddings/
  cache-index.sqlite
```

### 8.5 Cache UI

任务详情中展示：

```txt
上下文构成
  ✅ 项目摘要：命中缓存，12ms
  ✅ 文件 README.md：hash 未变，命中解析缓存
  ✅ 记忆召回：命中 6 条，FTS 8ms，向量未启用
  🟡 模型缓存：已设置 prompt_cache_key，服务商侧命中率由账单/usage 返回决定
  ❌ OCR：未安装，跳过扫描页
```

设置页新增：

```txt
缓存
  总大小：1.2GB
  文件解析：320MB
  下载包：640MB
  设计截图：120MB
  记忆召回：12MB
  [清理过期缓存] [清理下载缓存] [清理全部缓存]
```

### 8.6 关键指标

| 指标 | P0 目标 | P1 目标 |
|---|---:|---:|
| 文件解析重复命中率 | > 50% | > 80% |
| 记忆召回 p95 | < 300ms | < 150ms |
| 上下文拼装 p95 | < 500ms | < 250ms |
| 能力包重复下载率 | 0 | 0 |
| 设计截图缓存命中率 | > 30% | > 60% |
| 缓存错误自动恢复 | 100% | 100% |

---

## 9. Design 插件：Coding 必须使用设计闭环

### 9.1 原则

> 任何涉及前端 UI、布局、组件、样式、交互、可视化、响应式的 Coding 任务，都必须启用 DesignPlugin 流程。

这不是“可选美化”，而是编码质量门禁。

### 9.2 DesignPlugin 触发条件

```ts
function requiresDesignPlugin(task: TaskIntent, changedFiles: string[]): boolean {
  if (task.tags.includes('ui') || task.tags.includes('frontend') || task.tags.includes('design')) return true

  return changedFiles.some(path =>
    /apps\/.*\/src\/.*\.(tsx|jsx|css|scss|less)$/.test(path) ||
    /components\/.*\.(tsx|jsx)$/.test(path) ||
    /pages\/.*\.(tsx|jsx)$/.test(path) ||
    /routes\/.*\.(tsx|jsx)$/.test(path) ||
    /tailwind\.config\./.test(path) ||
    /design-tokens\.(json|ts)$/.test(path)
  )
}
```

### 9.3 DesignPlugin 工作流

```txt
用户提出前端/页面/组件修改
  ↓
Design Intake
  - 识别目标页面、组件、用户故事
  - 读取现有组件和样式
  - 扫描设计 token / 色彩 / 字体 / spacing
  ↓
Design Brief
  - 视觉目标
  - 组件约束
  - 响应式断点
  - 可访问性要求
  - 验收截图范围
  ↓
Plan Mode
  - 设计步骤
  - 代码步骤
  - 验证步骤
  ↓
用户审批
  ↓
Code Edit
  ↓
Visual Smoke
  - build
  - route screenshot
  - viewport 1366x768 / 1536x900 / mobile optional
  - diff summary
  ↓
Design Review Report
  ↓
Artifact / Audit
```

### 9.4 Design Handoff Bundle

每次 UI 编码任务生成：

```txt
.AgentCowork/design/<runId>/
  design-brief.md
  design-context.json
  component-inventory.json
  tokens.snapshot.json
  acceptance-checklist.md
  before/
    route-1536x900.png
    route-1366x768.png
  after/
    route-1536x900.png
    route-1366x768.png
  visual-diff.md
  design-review-report.md
```

`design-context.json` 示例：

```json
{
  "runId": "run_abc123",
  "task": "优化任务卡片和记忆面板展示",
  "routes": ["/"],
  "viewports": ["1536x900", "1366x768"],
  "designTokens": {
    "colors": ["--bg", "--panel", "--text", "--muted"],
    "spacingScale": [4, 8, 12, 16, 24, 32]
  },
  "components": [
    "TaskCard",
    "MemoryPanel",
    "CapabilityCenter",
    "FallbackBanner"
  ],
  "acceptance": [
    "记忆来源可见",
    "降级提示不遮挡主任务",
    "缓存命中状态以 badge 展示",
    "1366x768 无横向溢出"
  ]
}
```

### 9.5 Hooks 强制执行

新增内置 Hook：

```json
{
  "hooks": {
    "PlanCreated": [
      {
        "name": "require-design-brief-for-ui-task",
        "matcher": "task.tags contains frontend|ui|design",
        "decision": "require_design_plugin"
      }
    ],
    "PreToolUse": [
      {
        "name": "block-ui-edit-without-design-context",
        "matcher": "Edit|Write",
        "when": "target file is frontend file AND no design-context.json for run",
        "decision": "block"
      }
    ],
    "PostToolUse": [
      {
        "name": "run-visual-smoke-after-ui-edit",
        "matcher": "Edit|Write",
        "when": "target file is frontend file",
        "decision": "run_design_verification"
      }
    ]
  }
}
```

### 9.6 Design Pack 按需安装

基础 DesignPlugin 可以只生成设计文档和 checklist；如果需要截图、视觉 diff，则提示安装：

```txt
Frontend Design Pack
  需要：browser-automation-pack
  可选：image-diff、a11y-checker、storybook-adapter
```

如果用户不安装：

```txt
降级为 Static Design Review：
- 只检查组件结构、CSS/class 变更、设计 token 使用情况。
- 不执行截图 diff。
- UI 中标记“未运行视觉验证”。
```

---

## 10. 前端展示优化计划

### 10.1 新增四个关键面板

```txt
1. Context Stack 上下文栈
   展示本轮模型到底用了哪些文件、记忆、技能、缓存、工具结果。

2. Memory Panel 记忆面板
   展示“记住了什么、本次用了什么、可编辑/删除/暂停”。

3. Capability Center 能力中心
   展示岗位包、能力包、已安装、推荐安装、缺失依赖、离线导入。

4. Fallback & Cache Monitor 兜底与缓存监控
   展示降级原因、缓存命中、性能、重试和恢复建议。
```

### 10.2 任务中心展示升级

任务卡片从“run 列表”升级为：

```txt
任务标题
状态：运行中 / 等待审批 / 降级运行 / 失败可恢复 / 已完成
模型：DeepSeek / Kimi / 本地模型
安全模式：Local Strict / Hybrid / Cloud Opt-in
记忆：引用 6 条，新增 2 条待确认
缓存：命中 8/11
能力：缺少 OCR Pack，已降级
设计：DesignPlugin 已运行 / 未安装截图能力
产物：3 个
审计：可查看
```

### 10.3 “本次用了什么”必须透明

每次回复下方增加折叠块：

```txt
本次上下文
  文件：README.md、docs/xxx.md
  记忆：项目使用 Tauri、默认本地优先、用户偏好中文计划文档
  技能：project-upgrade-plan、memory-review
  能力包：core-text-pack
  缓存：文件解析命中、记忆召回命中
  降级：OCR 未安装，未处理图片页
```

### 10.4 新手引导补充

首次启动向导新增两步：

```txt
选择岗位
  开发 / 产品 / 设计 / 法务 / 财务 / HR / 销售 / 自定义

选择是否安装推荐能力包
  默认不安装，只展示推荐。
  用户点击后展示安装计划和权限。
```

记忆 onboarding 文案：

```txt
Agent Cowork 可以记住你的项目规则、工作偏好和常用流程。
你随时可以查看、编辑、删除、暂停或导出记忆。
隐身任务不会写入长期记忆。
```

---

## 11. API 设计

### 11.1 Memory API

```txt
GET    /api/memory/settings
POST   /api/memory/settings
GET    /api/memory/snapshot?projectId=&workspaceId=&threadId=
GET    /api/memory/items?scope=&kind=&projectId=
POST   /api/memory/items
PATCH  /api/memory/items/:id
DELETE /api/memory/items/:id
POST   /api/memory/recall
POST   /api/memory/candidates
POST   /api/memory/confirm
POST   /api/memory/pause
POST   /api/memory/incognito
POST   /api/memory/export
POST   /api/memory/import
POST   /api/memory/reset
GET    /api/memory/events?itemId=
```

### 11.2 Cache API

```txt
GET    /api/cache/stats
POST   /api/cache/clear
GET    /api/cache/entries?type=
DELETE /api/cache/entries/:id
GET    /api/cache/task/:runId
```

### 11.3 Capability / Install API

```txt
GET    /api/capabilities
GET    /api/capabilities/catalog
GET    /api/capabilities/recommend?role=&taskIntent=
POST   /api/install/plan
POST   /api/install/apply
GET    /api/install/jobs/:jobId
POST   /api/install/cancel/:jobId
POST   /api/install/offline-import
POST   /api/install/uninstall
GET    /api/install/history
```

### 11.4 Fallback API

```txt
GET    /api/fallback/status
GET    /api/fallback/run/:runId
POST   /api/fallback/retry
POST   /api/fallback/continue-degraded
```

### 11.5 Design API

```txt
POST   /api/design/intake
POST   /api/design/brief
GET    /api/design/context/:runId
POST   /api/design/verify
GET    /api/design/report/:runId
GET    /api/design/snapshots/:runId
```

---

## 12. 与 Skills / Recipes / Hooks 的衔接

### 12.1 Memory-aware Skills

Skills 可以声明自己需要或产生什么记忆：

```yaml
id: code-review
memory:
  reads:
    - user:coding-preferences
    - project:tech-stack
    - project:correction-rules
  writes:
    - correction
    - project-progress
    - capability-usage
```

### 12.2 Recipe 可以声明能力需求

```json
{
  "id": "contract-risk-table",
  "requiresCapabilities": ["pdf.read", "table.extract"],
  "optionalCapabilities": ["ocr.scan", "xlsx.write"],
  "fallback": {
    "missing:ocr.scan": "skip_scanned_pages_with_warning",
    "missing:xlsx.write": "write_csv_instead"
  }
}
```

### 12.3 Hooks 可以控制记忆和安装

```json
{
  "hooks": {
    "MemoryCandidateCreated": [
      {
        "name": "confirm-sensitive-memory",
        "when": "candidate.sensitivity in ['sensitive','secret']",
        "decision": "require_user_confirm"
      }
    ],
    "CapabilityMissing": [
      {
        "name": "suggest-pack-not-autoinstall",
        "decision": "show_install_plan"
      }
    ],
    "InstallPlanCreated": [
      {
        "name": "verify-pack-signature",
        "decision": "block_if_unsigned_or_checksum_missing"
      }
    ]
  }
}
```

---

## 13. 开发里程碑

### P0：MemoryCore 内置化 + UI 可见

目标：不依赖 MASE，也能跨窗口总结和召回基础记忆。

任务：

```txt
- 新增 apps/host/src/memory-core/*
- 新增 SQLite memory tables migration
- 新增 /api/memory/snapshot
- 新增 /api/memory/items CRUD
- 新增 MemoryPanel
- 新增隐身模式 / 暂停记忆 / 删除记忆
- 将现有 MASE bridge 改成 MemoryAdapter，而非主路径
- 每轮成功结束后写 ThreadSummary / ProjectSummary
- 每轮开始前读取 MemorySnapshot
```

验收：

```txt
- A 窗口告诉系统“本项目默认用 pnpm”，B 窗口同项目能召回。
- 切换到另一个项目不会自动带入该项目记忆。
- 隐身模式不读不写长期记忆。
- 删除一条记忆后，下一轮不再注入。
- 记忆召回失败不阻塞任务。
```

### P1：FallbackEngine + CacheService

目标：所有失败都有可解释降级，重复任务明显更快。

任务：

```txt
- 新增 apps/host/src/fallback/*
- 新增 apps/host/src/cache/*
- 文件解析缓存、记忆召回缓存、上下文拼装缓存
- ModelRouter 增加 cacheHints
- Kimi provider 增加 prompt_cache_key
- 前端 Context Stack 显示缓存命中
- FallbackBanner 显示降级原因和操作按钮
```

验收：

```txt
- 模型 429/超时可切备用或降级本地计划。
- MASE/MemoryCore 超时不影响回答。
- 同一文件重复解析命中缓存。
- 修改文件后缓存正确失效。
- UI 显示本轮命中/未命中。
```

### P2：CapabilityCenter + 按需安装下载

目标：核心包轻量；不同岗位按需下载。

任务：

```txt
- 新增 capability catalog
- 新增 pack manifest parser
- 新增 install plan / apply / status API
- 新增 checksum/signature 校验
- 新增 offline import
- 新增 uninstall
- 新增岗位推荐
- 新增安装审计 install.jsonl
```

验收：

```txt
- 新用户不安装任何重依赖也能跑基础任务。
- PDF OCR 任务提示安装 PDF OCR Pack，而不是直接失败。
- 用户能查看安装权限和依赖。
- checksum 错误必须阻断安装。
- 离线 .acpack 可导入。
- 卸载后 capability registry 正确更新。
```

### P3：DesignPlugin 强制用于 Coding UI 任务

目标：前端编码任务进入“设计 → 代码 → 视觉验证”闭环。

任务：

```txt
- 新增 apps/host/src/design-plugin/*
- 新增 DesignPanel
- 新增 Design Intake / Brief / Verify API
- 新增 frontend file detector
- 新增 require-design-brief-for-ui-task hook
- 新增 block-ui-edit-without-design-context hook
- 新增 Frontend Design Pack manifest
- 对接现有 smoke:rendered-ui / smoke:react-scroll / smoke:react-artifacts
```

验收：

```txt
- 修改 React 组件前必须生成 design-brief.md。
- 未安装浏览器包时降级为 Static Design Review。
- 安装 Frontend Design Pack 后可生成 before/after 截图。
- 1366x768 / 1536x900 视觉验收报告落盘。
- 设计报告进入任务产物和审计。
```

### P4：岗位包生态与企业策略

目标：Role Pack 可被组织管理和推荐，但永不自动安装。

任务：

```txt
- role profiles
- org allowlist / denylist
- marketplace source allowlist
- pack relevance signals
- pack usage analytics local-only
- enterprise offline mirror
```

验收：

```txt
- 管理员可禁止某类 pack。
- 市场源未 allowlist 不显示自动推荐。
- 推荐只发生在本地，不上传工作区信号。
- 用户确认后才安装。
```

---

## 14. 测试计划

### 14.1 Memory 测试

```txt
memory-core.test.ts
  - writes explicit user preference
  - rejects secrets
  - requires confirmation for sensitive memory
  - recalls project-scoped memory across windows
  - does not leak memory across projects
  - incognito reads no memory and writes no memory
  - pause memory keeps existing records but skips read/write
  - delete memory invalidates recall cache
  - summary compaction preserves source references
  - MASE adapter timeout degrades safely
```

### 14.2 Cache 测试

```txt
cache-service.test.ts
  - file parse cache hit by sha256
  - file change invalidates parse cache
  - memory version invalidates recall cache
  - context bundle key excludes raw secrets
  - cache corruption is detected and rebuilt
  - provider cache hints stable across resumed thread
```

### 14.3 Fallback 测试

```txt
fallback-engine.test.ts
  - model timeout switches provider
  - local strict blocks cloud provider and suggests local model
  - dependency missing returns install suggestion
  - sandbox fallback emits warning
  - SSE reconnect resumes run state
```

### 14.4 Install 测试

```txt
capability-install.test.ts
  - manifest schema validation
  - checksum mismatch blocks install
  - unsigned pack blocked when policy requires signature
  - offline acpack import works
  - uninstall removes registry entry but preserves audit
  - install never starts without explicit approval
```

### 14.5 DesignPlugin 测试

```txt
design-plugin.test.ts
  - ui task requires design brief
  - frontend file edit blocked without design context
  - static design review works without browser pack
  - visual smoke runs when browser pack installed
  - design report written to artifacts and audit
```

### 14.6 UI smoke

```txt
npm run smoke:memory-ui
npm run smoke:capability-center
npm run smoke:fallback-cache-ui
npm run smoke:design-plugin-ui
npm run smoke:cross-window-memory
```

---

## 15. 验收指标

| 模块 | 指标 | P0 | P1 |
|---|---:|---:|---:|
| 记忆召回 | 本地 p95 | < 300ms | < 150ms |
| 记忆安全 | secret 写入拦截 | 100% | 100% |
| 跨窗口 | 同项目召回成功率 | > 95% | > 98% |
| 隔离 | 跨项目误召回 | 0 | 0 |
| 缓存 | 文件解析重复命中 | > 50% | > 80% |
| 兜底 | 已知失败可解释率 | > 95% | > 99% |
| 安装 | 未授权自动安装 | 0 | 0 |
| 安装 | checksum mismatch 放行 | 0 | 0 |
| Design | UI 改动 design brief 覆盖率 | > 90% | 100% |
| Design | 视觉报告落盘率 | > 80% | > 95% |
| UI | 上下文来源可见 | 100% | 100% |

---

## 16. 代码文件建议清单

```txt
apps/host/src/memory-core/
apps/host/src/cache/
apps/host/src/fallback/
apps/host/src/capabilities/
apps/host/src/install/
apps/host/src/design-plugin/
apps/host/src/routes/memory.ts
apps/host/src/routes/cache.ts
apps/host/src/routes/capabilities.ts
apps/host/src/routes/install.ts
apps/host/src/routes/fallback.ts
apps/host/src/routes/design.ts

apps/web/src/components/memory/
apps/web/src/components/cache/
apps/web/src/components/capabilities/
apps/web/src/components/fallback/
apps/web/src/components/design/
apps/web/src/pages/MemoryPage.tsx
apps/web/src/pages/CapabilityCenterPage.tsx
apps/web/src/pages/DesignReviewPage.tsx

.agent-cowork/packs/
.agent-cowork/design/
.agent-cowork/memory/
.agent-cowork/cache/
```

---

## 17. 配置项建议

```env
# Memory
AGENT_MEMORY_ENABLED=1
AGENT_MEMORY_DEFAULT_SCOPE=project
AGENT_MEMORY_INCOGNITO_DEFAULT=0
AGENT_MEMORY_RECALL_TIMEOUT_MS=2000
AGENT_MEMORY_SUMMARY_MODEL=local-or-primary
AGENT_MEMORY_ALLOW_CLOUD_SUMMARY=0

# Cache
AGENT_CACHE_ENABLED=1
AGENT_CACHE_MAX_MB=4096
AGENT_CACHE_CONTEXT_BUNDLE_TTL_SEC=3600
AGENT_CACHE_TOOL_RESULT_TTL_SEC=600

# Capability / Install
AGENT_PACK_INSTALL_ENABLED=1
AGENT_PACK_REQUIRE_SIGNATURE=1
AGENT_PACK_MARKETPLACE_URL=
AGENT_PACK_OFFLINE_ONLY=0
AGENT_PACK_DOWNLOAD_DIR=.AgentCowork/downloads

# Fallback
AGENT_FALLBACK_ENABLED=1
AGENT_FALLBACK_MODEL_RETRY=2
AGENT_FALLBACK_ALLOW_DEGRADED_LOCAL_PLAN=1

# Design
AGENT_DESIGN_PLUGIN_REQUIRED_FOR_UI=1
AGENT_DESIGN_VISUAL_SMOKE_ENABLED=1
AGENT_DESIGN_DEFAULT_VIEWPORTS=1536x900,1366x768
AGENT_DESIGN_REQUIRE_BROWSER_PACK=0
```

---

## 18. 风险与控制

| 风险 | 说明 | 控制 |
|---|---|---|
| 记忆污染 | 用户临时一句话被永久记住 | candidate 分类 + scope + TTL + 用户可编辑 |
| 敏感记忆 | 密钥/客户信息被写入长期记忆 | redaction + secret detector + 禁止 secret 写入 |
| 跨项目泄漏 | A 项目记忆带到 B 项目 | project_id/workspace_id 强隔离 |
| 云模型总结外发 | 记忆总结把本地内容发给云 | Local Strict 禁止；Hybrid 需审批/脱敏 |
| 插件供应链 | 能力包下载恶意代码 | manifest + sha256 + 签名 + SBOM + allowlist |
| 安装膨胀 | 用户装太多包导致系统变慢 | 按需推荐 + 可卸载 + 缓存清理 |
| Design 插件阻塞开发 | 前端小改也强制复杂流程 | 小改走轻量 Static Design Review，大改走截图验证 |
| 缓存串用户 | 缓存 key 不含 tenant/user 隔离 | tenant/user/project 加入 key scope |
| 兜底误导 | 降级后用户以为完整能力仍可用 | UI 明确展示“降级运行” |

---

## 19. 推荐优先级

最推荐的实施顺序：

```txt
1. MemoryCore 内置化
2. MemoryPanel 可视化
3. CacheService 文件/记忆/上下文三类缓存
4. FallbackEngine 与降级 UI
5. CapabilityCenter 最小闭环：catalog → install plan → approve → verify → enable
6. Frontend DesignPlugin 基础版：design brief + static review
7. Browser/visual pack 按需安装
8. Role Pack 推荐与企业 allowlist
```

原因：

```txt
记忆是产品粘性；
兜底是可靠性；
缓存是速度和成本；
按需安装是长期生态；
Design 插件是 Coding 质量和前端体验的差异化。
```

---

## 20. 最小可落地版本定义

如果只做一个 2 周可验收版本，建议范围收缩为：

```txt
P0-MVP：
- 内置 SQLite MemoryCore
- 记忆面板：查看/删除/暂停/隐身
- 跨窗口项目摘要召回
- 文件解析缓存 + memory recall cache
- Kimi prompt_cache_key 接入
- FallbackBanner
- CapabilityCenter 只做“缺失能力提示”，暂不真实安装
- DesignPlugin 只做 design-brief + hook 阻断 UI 文件无设计上下文直接编辑
```

验收口径：

```txt
- 用户 A 窗口说“这个项目默认用 pnpm”，B 窗口让它写前端计划时能引用。
- 用户启用隐身模式后，这句话不会写入记忆。
- 用户删除记忆后，下一轮不再召回。
- 重复读取 README.md 命中文件解析缓存。
- Kimi 请求带稳定 prompt_cache_key。
- 模型不可用时 UI 显示降级，不白屏。
- 修改 React 组件前必须生成 design-brief.md。
```

---

## 21. 参考资料

- 当前项目 README：`README(9).md`
- Claude memory and chat search: https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- Claude Code power user tips / auto-memory: https://support.claude.com/en/articles/14554000-claude-code-power-user-tips
- Claude Cowork projects and project-scoped memory: https://support.claude.com/en/articles/14116274-organize-your-tasks-with-projects-in-claude-cowork
- Claude Code plugins: https://code.claude.com/docs/en/plugins
- Claude Code plugin relevance: https://code.claude.com/docs/en/plugin-relevance
- Claude Design: https://www.anthropic.com/news/claude-design-anthropic-labs
- Kimi Chat Completion API: https://platform.kimi.ai/docs/api/chat
- Kimi API overview: https://platform.kimi.ai/docs/overview
- Kimi Code: https://www.kimi.com/code/en
- Kimi Claw: https://www.kimi.com/bot
