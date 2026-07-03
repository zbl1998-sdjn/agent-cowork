# Agent Cowork SaaS 化大型优化计划

**副标题：** 本地优先、数据不出本地、保密与安全强化版  
**版本：** v1.0  
**日期：** 2026-07-02  
**适用对象：** Agent Cowork 项目负责人、产品/研发/安全/商业化团队  
**核心目标：** 将当前本地 Agentic Cowork 系统升级为可商业化、可企业部署、可审计的 Local-First Agentic SaaS 产品，同时将“默认不上传用户文件、不泄露敏感数据、不让模型越权执行”作为产品级承诺。

---

## 1. 执行摘要

Agent Cowork 已具备较强的本地 Agent 能力基础，包括 Agentic tool-calling loop、Plan Mode、MCP 协议栈、SQLite/PostgreSQL 双存储、审批机制、trusted root jail、敏感段黑名单、symlink 解析、redaction、JWT、SSRF 守卫、Host 头白名单、Docker `--network=none` 沙箱验证、审计与 smoke/coverage 体系。下一步不应简单做“云端聊天 SaaS”，而应定位为：

> **Local-First Agentic SaaS：云端做组织、身份、授权、策略、许可证、模板和设备管理；本地 Agent 做文件读取、代码执行、索引、记忆、审批、产物生成和敏感审计。**

最关键的产品边界是：

- SaaS 控制平面默认不接触用户文件内容、prompt、模型输出、embedding、长期记忆、完整文件路径和凭证。
- 本地数据平面在用户设备或客户内网运行，执行文件操作、代码沙箱、模型路由、审计与回滚。
- 对“真正不出本地”的客户，必须提供 **Local Strict 模式**：禁用外部模型 API、禁用非必要出站网络、强制本地模型或客户自托管模型，并将 Docker/VM 网络隔离作为硬门禁。
- 外部模型调用只能作为显式 opt-in 模式，且需要红线提示、脱敏、审批、审计和管理员策略控制。

---

## 2. 产品定位与商业化方向

### 2.1 一句话定位

**Agent Cowork 是面向个人开发者、知识工作者和企业团队的本地优先 AI 协作工作台：让 AI 在用户本地安全地读文件、写代码、生成文档、执行多工具任务，并通过 SaaS 控制平面完成组织化管理、策略下发和商业化订阅。**

### 2.2 与普通 AI SaaS 的差异

| 维度 | 普通云端 AI SaaS | Agent Cowork 目标形态 |
|---|---|---|
| 数据位置 | 文件/prompt 通常进入云端推理或存储链路 | 文件、索引、记忆、产物默认留在本地 |
| 执行位置 | 云端执行为主 | 本地 Agent 执行，云端只管策略/身份/授权 |
| 安全承诺 | 依赖服务商数据处理承诺 | 技术上通过本地数据平面减少外泄面 |
| 企业控制 | 云端租户配置为主 | 本地策略引擎 + 企业策略中心双层控制 |
| Agent 风险 | 插件/工具越权风险高 | 工具分级、审批、沙箱、审计、回滚、出站阻断 |

### 2.3 建议目标客户

1. **个人专业版**：开发者、咨询顾问、研究人员，需要本地文件协作和文档生成。
2. **团队版 SaaS**：小团队希望统一 license、模板、连接器和工作流，但不希望文件上传云端。
3. **企业安全版**：研发、法务、财务、制造、医疗、政企等高保密场景，需要本地/内网部署、SSO、策略审计、DLP 和离线模型。
4. **私有化/离线版**：严格数据主权、内网隔离或合规行业客户。

---

## 3. 当前项目基线判断

### 3.1 可直接产品化的资产

- **Agentic loop 与工具体系**：已支持 Read/Write/Edit/Glob/Grep/Shell/WebFetch 等多步工具调用。
- **Plan Mode 与审批闭环**：写操作前生成计划并等待用户审批，适合转化为企业级 human-in-the-loop 控制。
- **MCP 协议栈**：已有 StdioTransport、JsonRpc、McpClient、connect 和 `mcp__<server>__<tool>` 命名空间，可扩展为连接器市场和企业私有连接器。
- **稳定性基础**：CircuitBreaker、Token Bucket、ApprovalRegistry TTL、SSE 断连恢复、PostgreSQL LISTEN/NOTIFY 等能力，适合向多实例 SaaS 演进。
- **安全边界基础**：trusted root jail、敏感段黑名单、symlink 解析、redaction、JWT、SSRF 守卫、Host 头白名单、`shell:false`、Docker `--network=none` 验证。
- **本地产物与审计**：artifact、run、audit、rollback 已有雏形，可升级为合规级证据链。
- **前端与桌面端基础**：React/TypeScript、Tauri 2、Node SEA、Windows C/WebView2 客户端骨架。

### 3.2 SaaS 化前必须解决的差距

| 差距 | 当前风险 | SaaS 化要求 |
|---|---|---|
| 外部模型调用边界 | 配置 Kimi/Moonshot 后，prompt/context 会出本地 | 增加 Local Strict、本地模型、客户 VPC 模型网关和外部模型显式 opt-in |
| 本地沙箱回退 | Docker 不可用时可能回退到本地子进程，Windows 下网络不隔离 | 企业安全模式下禁止不隔离回退；必须显示阻断或降级为只读 |
| 多租户控制平面 | 已有 tenant scope 测试基础，但未形成完整 SaaS org/account/billing | 建立组织、成员、角色、设备、license、策略、审计摘要模型 |
| 策略体系 | 现有审批与路径策略较硬编码 | 建立企业策略 DSL：工具、路径、网络、模型、连接器、审计、DLP |
| 凭证与密钥 | 已有 DPAPI/脱敏雏形 | 跨平台 Keychain/DPAPI/libsecret + 本地 vault + rotation + connector scopes |
| 合规证据 | 测试覆盖强，但还不是合规包 | 补齐 threat model、SBOM、签名更新、渗透测试、事件响应、SOC 2 证据 |
| 产品包装 | MVP 验证命令丰富，但客户上手路径复杂 | 安装器、首次引导、管理员后台、策略模板、诊断报告、商业版本分层 |

---

## 4. 目标架构：云控本地执行

### 4.1 总体架构

```text
企业管理员 / 用户
       │
       ▼
SaaS 控制平面（云端或客户私有化）
- 组织/成员/角色/SSO
- License/Billing
- 设备注册与策略下发
- 模板/Recipe/连接器目录
- 安全态势摘要，不收集文件内容
       │ 仅同步策略、授权、版本、匿名/聚合健康状态
       ▼
本地数据平面（用户设备/客户内网）
- Local Agent / Host API / Desktop UI
- trusted root workspace
- 本地索引、记忆、产物、审计、回滚
- 工具网关、审批引擎、DLP、redaction
- Docker/VM/Job Object 沙箱
- 本地模型或客户自托管模型网关
       │
       ▼
本地文件系统 / 代码仓库 / 企业内网工具
```

**边界原则：** 云端控制平面不读取文件、不接收 prompt、不保存产物、不存 embedding、不远程执行 shell。它只负责“谁可以在什么设备上，以什么策略运行什么能力”。

### 4.2 控制平面模块

| 模块 | 主要职责 | 不允许做的事 |
|---|---|---|
| Identity & Org | 账号、组织、团队、角色、SSO/OIDC/SAML | 不存本地文件内容 |
| Policy Center | 下发工具、路径、网络、模型、连接器、审批策略 | 不直接绕过本地审批 |
| Device Registry | 设备注册、设备姿态、版本、吊销 | 不获取本地目录树全文 |
| License/Billing | 订阅、席位、用量额度、发票 | 不以文件内容作为计费指标 |
| Template/Recipe Hub | 发布可签名的工作流模板 | 不允许模板隐式开启高风险工具 |
| Security Dashboard | 展示风险摘要、策略命中、版本合规 | 不上传 prompt、输出、文件片段 |
| Update Service | 签名发布、灰度、回滚 | 不发布未签名二进制 |

### 4.3 本地数据平面模块

| 模块 | 主要职责 | 关键控制 |
|---|---|---|
| Local Host API | 本地 UI/API、workspace、runs、artifacts | 绑定 127.0.0.1、Host 白名单、CSRF/Origin 校验 |
| Policy Engine | 执行本地/云端策略合并后的最终决策 | deny-by-default、策略版本审计 |
| Tool Gateway | 所有工具调用统一入口 | 风险分级、参数校验、审批、审计 |
| Sandbox Executor | Shell/code/web fetch 隔离执行 | network=none、文件系统最小挂载、资源限制 |
| Local Vault | API key、OAuth token、设备凭证 | DPAPI/Keychain/libsecret、永不进日志 |
| Local Memory/Index | 本地长期记忆、embedding、RAG | 本地加密、按 workspace 隔离、可删除 |
| Model Router | 本地模型、客户模型、外部模型路由 | Local Strict 默认禁用外部模型 |
| Audit & Rollback | JSONL/hash-chain 审计、产物、回滚 | append-only、tamper-evident、可导出 |

---

## 5. “不出本地”产品模式设计

### 5.1 三种运行模式

| 模式 | 适用客户 | 数据流承诺 | 模型策略 | 网络策略 |
|---|---|---|---|---|
| Local Strict | 高保密、政企、法务、医疗、内网 | 文件、prompt、输出、索引、记忆全部留本地 | 仅本地模型或客户内网模型 | 默认无外网；仅允许 license 离线包或管理员批准域名 |
| Enterprise Hybrid | 企业团队 | 文件留本地；可调用客户自有 VPC/内网模型 | 客户托管模型网关 | 仅 allowlist 到企业控制平面/模型网关 |
| SaaS Opt-in | 普通 Pro/Team 用户 | 用户明确开启后，必要 prompt 可发外部模型 | 外部模型需显式提示和审计 | 出站经过 redaction、审批和 provider allowlist |

### 5.2 必须明确的真实边界

“真正不出本地”只有在 Local Strict 或客户内网模型模式下才能成立。若使用 Kimi、Moonshot、OpenAI 或任何公网模型 API，prompt/context 必然离开本机。因此产品必须在 UI、策略和审计中把模型模式说清楚：

- **绿色标识：Local Strict** - 无外部模型、无外部工具网络、所有内容在本地。
- **黄色标识：Enterprise Hybrid** - 内容可能进入客户自有内网模型或私有云模型。
- **红色标识：External Opt-in** - 内容可能发送至第三方模型提供商，必须二次确认和记录。

### 5.3 数据分类与处理策略

| 数据类型 | 示例 | 默认位置 | 是否允许进 SaaS 云端 | 控制要求 |
|---|---|---|---|---|
| 用户原始文件 | 源码、合同、表格、PDF、图片 | 本地 trusted root | 默认禁止 | path jail、DLP、只读摘要、审批 |
| Prompt 与上下文 | 用户问题、文件摘录、工具结果 | 本地 | 默认禁止 | Local Strict 禁止外发；Opt-in 才能出站 |
| 模型输出 | 计划、代码、报告、文档 | 本地 artifacts/runs | 默认禁止全文上传 | 本地审计、可导出、可删除 |
| Embedding/索引 | 向量库、关键词索引 | 本地加密库 | 禁止 | workspace 隔离、删除权、重建权 |
| 长期记忆 | MASE/结构化事实/会话摘要 | 本地或客户内网 | 默认禁止 | 明示开关、事实来源、删除/导出 |
| 凭证 | OAuth token、API key、device secret | 本地 vault | 禁止 | OS 密钥库、脱敏、轮换、scope 最小化 |
| 审计摘要 | run id、策略版本、风险级别、时间 | 本地；可选聚合上报 | 允许最小化摘要 | 不含文件内容/路径全文/prompt |
| License 数据 | 组织、席位、订阅状态 | 云端 | 允许 | 与内容数据隔离 |
| 崩溃/诊断 | 版本、错误码、堆栈摘要 | 本地；可选上传 | 需 opt-in | 自动 scrub 路径、token、prompt |

---

## 6. 安全与保密设计

### 6.1 零信任与最小权限

- 所有访问按“用户、设备、workspace、工具、路径、模型、网络目标、时间、风险级别”综合决策。
- 默认拒绝高风险工具；写入、删除、移动、shell、外部网络、连接器写操作必须可解释、可审批、可撤销。
- 设备需要注册、签名、策略绑定和吊销；本地 Agent 与云端控制平面之间使用短期 token 与设备密钥。
- SaaS 租户之间必须做到数据库、对象存储、缓存、队列、日志和后台任务的 tenant isolation。

### 6.2 本地沙箱与出站网络控制

- Enterprise/Local Strict 模式下：Docker/VM 沙箱不可用时，不允许自动回退到不隔离的 LocalSubprocessSandbox 执行高风险工具。
- Shell/code 执行默认 `network=none`，只挂载必要工作目录，只给最小 CPU/内存/时间预算。
- WebFetch、连接器、模型调用统一走 Egress Gateway：域名 allowlist、IP 解析复核、重定向逐跳复核、私网/元数据地址阻断。
- Windows 场景补齐 Job Object/AppContainer/WDAC/Defender 集成，至少提供“网络不隔离时只读降级”的强提示。

### 6.3 Tool 权限分级

| 等级 | 示例工具 | 默认策略 | 审批要求 |
|---|---|---|---|
| L0 只读低风险 | list、read trusted root 内小文件 | 允许 | 无需审批，但记录审计 |
| L1 只读敏感 | read 大文件、读取疑似密钥文件、读取隐藏目录 | 默认需策略判断 | 可能需要审批/脱敏 |
| L2 本地写入 | write/edit/rename/move | 计划后允许 | 必须审批、预览 diff、可回滚 |
| L3 执行类 | shell、代码执行、构建脚本 | 默认拒绝 | 必须审批 + 沙箱 + 资源限制 |
| L4 外联类 | WebFetch、外部模型、OAuth connector | 默认拒绝 | 必须策略 allowlist + 二次确认 |
| L5 高危破坏 | 删除大量文件、执行未知二进制、改系统目录 | 禁止 | 仅企业管理员临时 break-glass |

### 6.4 LLM/Agent 安全

- 把外部文件、网页、issue、邮件内容全部视为不可信输入，防 prompt injection。
- 模型输出不得直接进入 shell、SQL、浏览器 DOM 或文件系统；必须经结构化 schema、策略校验和 human approval。
- 工具调用采用 capability token：一次计划、一次授权、限定参数、限定路径、限定有效期。
- 外部模型调用前做 prompt redaction、secret scanning、路径压缩、上下文最小化。
- 系统提示、策略、连接器凭证不得进入普通模型上下文。
- 对 “excessive agency” 做硬限制：最大步数、最大并发、最大上下文、最大写入文件数、最大网络请求数。

### 6.5 凭证与密钥

- Windows 使用 DPAPI，macOS 使用 Keychain，Linux 使用 libsecret/Secret Service；企业版支持客户 KMS/HSM。
- OAuth device flow 不把 device_code 下发前端；token 状态只展示 scope、到期时间、脱敏主体。
- 本地 `.env` 需要自动 secrets scan，禁止被 Agent 读取或写入产物，除非用户 break-glass。
- 所有 token、API key、cookie、Authorization header 自动 redaction；日志中只保留 hash/后四位。

### 6.6 审计与不可抵赖

- 本地 JSONL 审计升级为 hash-chain：每条事件包含 prev_hash、policy_version、tool_call_id、approval_id、risk_level、actor、device_id、workspace_id。
- 对写入操作保存 preview、diff、approval、apply result、rollback recipe。
- 企业可导出审计包，但默认不上传内容；云端仅保存摘要指纹和策略命中统计。
- 对管理员 break-glass 操作做强审计、强理由、强时限。

### 6.7 软件供应链安全

- 所有发布包、sidecar、连接器、recipe 进行代码签名和签名校验。
- 生成 SBOM，启用 SCA、SAST、secrets scanning、dependency pinning、provenance/SLSA 风格构建记录。
- Update Service 支持灰度、回滚、版本冻结、企业私有更新源。
- MCP 连接器必须有 manifest：权限、网络域名、scope、数据类型、风险级别、维护者签名。

---

## 7. SaaS 产品功能规划

### 7.1 核心产品模块

| 模块 | 用户价值 | MVP 范围 | 企业增强 |
|---|---|---|---|
| 本地工作台 | 文件协作、代码/文档生成、产物管理 | workspace、tree、Plan Mode、artifact | 多 workspace、模板、批处理、团队 recipe |
| 本地 Agent | 多工具任务执行 | read/write/edit/shell/webfetch/MCP | 沙箱强制、DLP、模型路由、策略 DSL |
| 管理后台 | 组织与设备管理 | org、seat、device、policy | SSO、SCIM、审计、风险仪表盘 |
| 策略中心 | 统一安全边界 | 模型/工具/路径 allowlist | ABAC、审批流、break-glass、版本回滚 |
| 连接器中心 | GitHub/文件系统/MCP 扩展 | 内置连接器 + OAuth | 私有连接器、签名、scope 审批 |
| 模板/Recipe | 提升复用与商业价值 | summary-report、代码审查、整理文件 | 企业模板库、审批模板、合规报告 |
| 安全中心 | 建立信任 | 本地诊断、安全模式标识 | 合规导出、SIEM webhook、EDR 集成 |
| Billing/License | 商业化 | Pro/Team 订阅 | 企业合同、离线 license、私有化授权 |

### 7.2 版本分层建议

| 版本 | 定位 | 关键限制/能力 |
|---|---|---|
| Free Local | 个人试用 | 单设备、本地 workspace、基础 Plan Mode、无团队后台 |
| Pro Local | 个人专业 | 多 workspace、本地模型/外部模型 opt-in、更多 recipe |
| Team SaaS | 小团队 | 组织、席位、共享模板、设备注册、基础策略 |
| Enterprise Secure | 中大型企业 | SSO/SCIM、Local Strict、策略中心、审计导出、私有连接器 |
| Enterprise Private/Air-gapped | 高保密客户 | 私有化控制平面、离线 license、内网模型、离线更新源 |

---

## 8. 开发路线图

### Phase 0：产品边界与威胁建模（第 1-2 周）

**目标：** 定义 SaaS 与本地边界，避免后续架构返工。

交付物：

- Product Security Charter：明确“不出本地”的技术含义、例外、UI 标识和法律表述。
- 数据流图 DFD：文件、prompt、模型、审计、凭证、license 全链路。
- STRIDE/LINDDUN 威胁模型与风险登记册。
- SaaS 多租户数据模型草案：Org、User、Role、Device、Policy、License、Recipe。
- Local Strict 模式验收清单。

验收标准：

- 能清楚回答“哪些数据永远不进云端、哪些数据可选进云端、哪些模式下 prompt 会出本地”。
- 完成高危威胁列表与优先级排序。

### Phase 1：本地安全模式硬化（第 3-8 周）

**目标：** 先把本地 Agent 做成可被企业信任的数据平面。

关键任务：

- 增加 `SECURITY_MODE=local_strict|enterprise_hybrid|saas_opt_in`。
- Enterprise/Local Strict 模式禁止不隔离 sandbox 回退。
- 实现 Egress Gateway：域名/IP allowlist、DNS rebinding 防护、重定向复核、出站审计。
- 模型路由：local model、customer model gateway、external provider 三路，默认 local。
- 本地 vault 抽象：DPAPI/Keychain/libsecret，统一 token 生命周期。
- 本地加密存储：runs、artifacts、memory、index 可选加密。
- 工具风险等级和 policy DSL 初版。
- Prompt/context redaction 与 secret scanning。

验收标准：

- Local Strict 下任何外部模型和 WebFetch 默认失败并产生审计。
- Docker/VM 不可用时，高风险工具不执行而不是静默回退。
- 单测和 smoke 覆盖出站阻断、path traversal、symlink、secret redaction、prompt injection 基线。

### Phase 2：SaaS 控制平面 MVP（第 9-16 周）

**目标：** 建立可收费、可管理、但不碰内容的云端产品外壳。

关键任务：

- Org/User/Role/Device/License 数据模型。
- Device enrollment：一次性 code、设备密钥、吊销、策略绑定。
- Policy Center：策略创建、版本、签名、下发、回滚。
- Admin Console：设备列表、版本状态、安全模式、策略合规。
- License/Billing：席位、订阅状态、离线 license token。
- 最小 telemetry：仅版本、模式、策略 hash、健康码、匿名计数，不含内容。
- 控制平面 API 多租户隔离测试。

验收标准：

- 新设备可注册到 org，拉取签名策略，本地执行策略决策。
- 云端数据库中不存在文件内容、prompt、模型输出、embedding。
- 跨租户访问、IDOR、缓存串租户、队列串租户均有自动化测试。

### Phase 3：团队协作与模板商业化（第 17-24 周）

**目标：** 增加 SaaS 付费价值，不牺牲本地隐私。

关键任务：

- Team recipe/template：模板存在云端，执行在本地。
- 组织级 MCP connector catalog：manifest、scope、签名、风险级别。
- 审批流模板：普通用户、项目负责人、安全管理员。
- 本地产物包导出：Markdown/DOCX/PPTX/PDF 与审计证据打包。
- 团队策略推荐：研发/法务/财务/高保密模板。

验收标准：

- 管理员发布模板后，成员本地执行，云端不接收产物内容。
- 高风险连接器未授权时无法注册或执行。

### Phase 4：企业安全与合规准备（第 25-36 周）

**目标：** 从“安全功能”升级为“可被采购与审计接受”。

关键任务：

- SOC 2 Type I 准备：访问控制、变更管理、供应链、事件响应、备份恢复、供应商管理。
- 安全白皮书与数据处理说明：明确 Local Strict、Hybrid、Opt-in 三种模式。
- 第三方渗透测试与 LLM red team。
- SBOM、签名发布、漏洞响应 SLA、CVE 流程。
- SIEM webhook：只发事件元数据与 hash，不发内容。
- 私有化部署 Helm/Docker Compose/Windows Installer。

验收标准：

- 能给企业客户提供安全包：架构图、数据流、控制矩阵、渗透测试摘要、SBOM、DPA、安全 FAQ。
- 管理员可以证明某台设备处于 Local Strict，且外部网络调用被阻断。

### Phase 5：规模化与生态（第 37 周以后）

**目标：** 建立可扩展的 SaaS 增长和生态壁垒。

关键任务：

- 连接器市场与企业私有连接器 SDK。
- Agent workflow marketplace，但所有 workflow 必须签名和权限声明。
- 企业内网模型适配：vLLM、Ollama、LM Studio、Azure OpenAI Private Link、Bedrock/VPC 等。
- 更完整的本地 RAG、代码库理解、文档生成、批处理任务。
- Partner/SI 交付包：私有化部署、合规行业模板。

---

## 9. 关键技术 Backlog

| 优先级 | Epic | 具体任务 | 验收标准 |
|---|---|---|---|
| P0 | 安全模式 | `local_strict` 强制禁外部模型/网络 | egress 测试 100% 阻断 |
| P0 | 模型路由 | local/customer/external provider 抽象 | UI 明确显示数据流模式 |
| P0 | 沙箱硬化 | 禁止不隔离高危回退 | Docker 不可用时高危工具失败 |
| P0 | 策略引擎 | 工具/路径/网络/模型/连接器 DSL | 所有 tool call 都经 policy decision |
| P0 | 数据分类 | prompt、文件、embedding、audit 分类 | 日志无内容泄漏测试通过 |
| P1 | 本地加密 | runs/artifacts/memory/index 加密选项 | 关闭应用后密文不可读 |
| P1 | Vault | OS keychain 统一接口 | token 不出现在前端和日志 |
| P1 | SaaS 租户 | org/user/role/device/license | 跨租户测试通过 |
| P1 | Device enrollment | 设备注册/吊销/策略绑定 | 被吊销设备无法拉取新策略 |
| P1 | 签名更新 | installer/sidecar/recipe 签名 | 未签名包拒绝执行 |
| P2 | Admin Console | 策略、设备、安全态势 | 管理员可看合规摘要 |
| P2 | 审计 hash-chain | tamper-evident audit | 篡改单行可被检测 |
| P2 | 连接器 manifest | scope/domain/risk 签名声明 | 未授权 scope 不可执行 |
| P2 | SIEM 导出 | 元数据 webhook | 不含 prompt/文件内容 |
| P3 | 私有化部署 | compose/helm/offline license | 内网环境可运行 |

---

## 10. 威胁模型摘要

| 威胁 | 典型场景 | 影响 | 缓解措施 |
|---|---|---|---|
| Prompt Injection | README/网页/issue 中藏恶意指令 | 越权工具调用、泄露数据 | 不可信内容隔离、tool policy、human approval、输出 schema 校验 |
| 数据外泄 | 外部模型/WebFetch/连接器带出文件片段 | 商业秘密泄露 | Local Strict、egress gateway、redaction、provider opt-in |
| 路径逃逸 | symlink/path traversal 访问 root 外文件 | 读取敏感系统文件 | trusted root jail、realpath、敏感段黑名单、测试覆盖 |
| SSRF/DNS rebinding | WebFetch 访问内网或 metadata | 内网探测/凭证泄露 | IP 判定、重定向复核、Host 白名单 |
| Shell RCE | 模型生成危险命令 | 文件破坏、横向移动 | sandbox network=none、只读挂载、审批、资源限制 |
| 凭证泄露 | token 进入日志或模型上下文 | 账号接管 | vault、redaction、secret scanning、scope 最小化 |
| 租户串扰 | API IDOR/cache/queue 串租户 | SaaS 数据泄露 | tenant scoped schema、鉴权中间件、隔离测试 |
| 供应链攻击 | 恶意连接器/recipe/update | 执行恶意代码 | 签名、SBOM、manifest、review、allowlist |
| 本地恶意文件 | 用户 workspace 包含恶意脚本 | Agent 被诱导执行 | 文件即不可信、执行审批、沙箱、静态扫描 |
| 审计篡改 | 用户或恶意进程删改 JSONL | 证据失效 | hash-chain、定期摘要、可选企业远端摘要锚定 |

---

## 11. 验收与测试门禁

### 11.1 安全门禁

- SAST/SCA/secrets scanning 在 CI 中强制执行。
- 单元测试覆盖 policy、path jail、symlink、SSRF、tenant isolation、OAuth、vault、redaction。
- LLM red-team 覆盖 OWASP LLM 风险：prompt injection、sensitive disclosure、excessive agency、insecure plugin/tool design。
- 出站网络测试：Local Strict 模式下模型、WebFetch、connector 外联全部失败并审计。
- 安装包签名验证测试：未签名/签名错误包拒绝更新。
- 日志扫描测试：prompt、文件片段、token、secret、完整路径不得进入云端 telemetry。

### 11.2 产品门禁

- 首次启动必须清晰选择安全模式。
- 每个 run 必须显示：模型位置、本地/外部数据流、工具风险、审批状态。
- 每个写操作必须有 preview/diff/rollback。
- 管理员后台必须能回答：哪些设备在线、使用什么版本、处于什么安全模式、策略是否最新。
- 支持一键导出本地审计包与安全诊断包，导出前可预览是否含敏感内容。

### 11.3 隐私门禁

- 默认 telemetry 只允许：版本、OS、匿名错误码、策略 hash、功能计数。
- 禁止上传：文件内容、prompt、输出全文、embedding、记忆、token、完整本地路径。
- 诊断上传必须 opt-in，并先做本地 scrub。
- 删除账号不影响本地文件；删除设备注册只吊销云端控制能力。

---

## 12. 安全标准映射

| 标准/框架 | 对本项目的用法 |
|---|---|
| NIST CSF 2.0 | 作为企业安全治理目录：Govern、Identify、Protect、Detect、Respond、Recover |
| NIST SP 800-207 Zero Trust | 作为身份、设备、资源、策略决策和持续验证的架构依据 |
| NIST SP 800-218 SSDF | 作为安全开发生命周期、供应链、漏洞响应和发布门禁依据 |
| NIST Privacy Framework | 作为隐私风险管理和 privacy-by-design 的产品依据 |
| OWASP ASVS | 作为 SaaS 控制平面和 Host API 的可测试安全要求 |
| OWASP Top 10 / OWASP LLM Top 10 | 作为 Web/Agent/LLM red team 和安全测试基线 |

---

## 13. 商业化与交付策略

### 13.1 MVP 销售故事

> “你的文件不需要上传到我们的云。Agent Cowork 在你的电脑或企业内网里运行，云端只负责授权、策略和团队管理。你可以选择完全本地模型，也可以在管理员批准后接入企业自有模型或第三方模型。”

### 13.2 建议包装资产

- 安全白皮书：本地数据平面、云端控制平面、三种数据流模式。
- 采购 FAQ：数据是否上传、模型是否训练、日志包含什么、如何删除、如何私有化。
- 合规包：DPA、子处理方说明、SBOM、渗透测试摘要、事件响应流程。
- Demo 脚本：Local Strict 下尝试外联被阻断；写操作审批和回滚；连接器 scope 审批。
- ROI 模板：文档整理、代码审查、报告生成、合规审计提效。

### 13.3 定价方向

- Free：建立信任和开发者口碑。
- Pro：按个人席位订阅，核心价值是本地多工具协作和高级模板。
- Team：按席位 + 组织策略 + 共享模板。
- Enterprise：按席位/设备/私有化部署收费，重点卖安全、合规、SSO、审计、离线模型。

---

## 14. 近期 10 项落地动作

1. 新建 `docs/product-security-charter.md`，明确“不出本地”的技术边界和三种运行模式。
2. 新建 `docs/data-flow.md`，画出文件、prompt、模型、审计、凭证、license 的 DFD。
3. 在 Host 增加 `SECURITY_MODE`，默认开发可宽松，企业包默认 `local_strict`。
4. 将 sandbox 选择从“自动回退”改为“按安全模式决策”：Local Strict 不允许高危工具回退本地子进程。
5. 抽象 `ModelRouter`：local、customer_gateway、external_provider，外部 provider 必须标记和审批。
6. 所有工具调用进入统一 `PolicyDecision`，输出 allow/deny/needs_approval + reason + audit fields。
7. 增加云端 telemetry allowlist 测试，确保 prompt/文件内容永远不进上报队列。
8. 设计 SaaS 控制平面最小 schema：Org、User、Role、Device、Policy、License、AuditSummary。
9. 增加连接器 manifest 格式：name、version、permissions、domains、risk、signature。
10. 准备企业 Demo：Local Strict 外联阻断、审批写入、审计 hash-chain、设备策略下发。

---

## 15. 决策清单

| 决策点 | 推荐结论 |
|---|---|
| SaaS 是否保存文件内容 | 不保存，除非未来单独做明确 opt-in 的云同步产品 |
| SaaS 是否保存 prompt | 默认不保存；外部模型 opt-in 也只在本地留审计 |
| 默认模型 | 本地模型/空配置；外部模型需用户或管理员开启 |
| 企业模式下 Docker 不可用 | 高风险工具失败，不回退不隔离执行 |
| Telemetry | allowlist、最小化、可关闭、可本地预览 |
| 审计 | 本地完整审计，云端只存摘要或不存 |
| 连接器 | manifest + scope + 签名 + 审批 |
| 私有化 | 从 Enterprise 阶段开始设计，不要后补 |

---

## 16. 参考依据

- 用户上传 README：Agent Cowork 当前能力、测试、MVP、Kimi API、MCP、sandbox、审计、Windows readiness 等说明。
- NIST Cybersecurity Framework 2.0, 2024.
- NIST SP 800-207 Zero Trust Architecture.
- NIST SP 800-218 Secure Software Development Framework.
- NIST Privacy Framework.
- OWASP Application Security Verification Standard.
- OWASP Top 10 Web Application Security Risks.
- OWASP Top 10 for Large Language Model Applications 2025.
