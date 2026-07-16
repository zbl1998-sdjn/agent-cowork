# Agent Cowork 2.6 · 热门 Agent 对标改进计划(2026-07)

> 调研日期:2026-07-16。本文基于当日一手来源(各产品官方 README/changelog/官网 + 当日 web 检索)对 2026 年中热门 agent 产品做能力盘点,并映射到本仓库(v0.5.0 Internal Beta,`refactor/kimi-to-agent-rename` 分支)的现有模块给出改进优先级。
> 前置:遵守 `plan/00-架构基线与模块依赖.md` 分层;所有新能力必须过安全边界(path jail / 审批 / egress 网关);一特性一提交,特征测试先行。
> 本文取代 2026-05 的 `docs/kimi-vs-claude-cowork-gap.md` 作为当前对标基线(旧文保留为历史档案)。

---

## 1. 2026-07 热门 agent 能力盘点(一手来源)

| 产品 | 当前签名能力(2026-07) | 来源 |
| --- | --- | --- |
| **Claude Cowork**(Anthropic,2026-01 预览/2026-04 GA/2026-07 上 web+移动) | 文件夹授权 + 直接操作本地文件(PPT/带公式表格);多步任务 + 子代理并行;插件 = skills+连接器+子代理打包;Artifacts 跨端共享;定时任务服务端运行(无需设备在线);computer use 研究预览 | support.claude.com、anthropic.com/product/claude-cowork、TechCrunch 2026-07-07 |
| **Claude Code 2.1.x** | 后台 agent(`claude agents` 视图,attach/peek/阻塞态提示);agent teams + workflows(确定性多 agent 编排);auto mode(权限分类器自动放行低风险、危险命令仍拦);MEMORY.md 记忆索引;checkpoint + transcript 剪枝;审批预览中和 bidi/零宽/形近字符;后台通知显式声明"无人类输入"防伪造审批 | github.com/anthropics/claude-code CHANGELOG(2.1.205–2.1.211) |
| **OpenAI Codex** | CLI + IDE + 桌面 app(`codex app`)+ 云端(Codex Web)同一 agent 多表面;skills 支持 | github.com/openai/codex README、developers.openai.com/codex/skills |
| **Cline** | 多 agent teams(coordinator 拆解 + specialist 委派,团队状态跨会话持久);Kanban 看板(每卡片独立 worktree + 自动 commit + 依赖链);定时 agent;消息平台接入(Slack/Telegram/Discord/WhatsApp/Linear);SDK 插件系统;headless CI/CD | github.com/cline/cline README |
| **OpenHands Agent Canvas** | 自托管"agent 控制中心":本地/Docker/VM/云多后端切换;可运行任意 ACP 兼容 agent(Claude Code/Codex/Gemini);schedule/webhook 触发自动化 + Slack/GitHub/Linear 集成 | github.com/All-Hands-AI/OpenHands README |
| **Gemini CLI / Gemini Spark** | 免费额度 + 搜索 grounding;Spark 为 24/7 云端 agent(2026-05-19) | github.com/google-gemini/gemini-cli README、LogRocket 2026-07 榜单 |
| **Agent Skills 开放标准** | SKILL.md(YAML frontmatter + Markdown 指令 + 可选脚本/引用文件);2025-12-18 Anthropic 开放,48h 内 Microsoft/OpenAI 跟进,2026-06 约 40 家产品支持(Claude/Codex/Copilot/VS Code/Cursor/Gemini CLI/Goose 等),skills.sh 生态 52.5 万+ skills | agentskills.io、thenewstack.io、paperclipped.de 汇总 |
| 市场趋势 | "隐私优先、本地运行、持久记忆的桌面 copilot"是新品主流方向(与本项目定位一致) | LogRocket AI dev tool power rankings 2026-07 |

## 2. 差距矩阵(热门能力 × 本仓库现状)

| 热门能力 | 本仓库现状 | 差距判定 |
| --- | --- | --- |
| Agent Skills(SKILL.md)标准 | `apps/host/src/skills/` 只有自有 capability-pack 目录(纯描述、不加载);全仓无 SKILL.md 解析 | **缺失,生态级杠杆最大** |
| 后台/异步 agent + 可交互任务面板 | 有 checkpoint/resume、`.AgentCowork/runs`、0.4.0 只读任务中心;run 与前台 SSE 会话绑定,无 attach/peek/后台审批 | **半缺:存储层就绪,交互层缺失** |
| 权限自动分级(auto mode 分类器) | 0.4.0 已有 `plan/manual/guarded_auto` 三档 + 静态工具风险分类 | 半缺:缺模型分类器与"always allow"持久规则 |
| 审批展示防欺骗(bidi/零宽/形近字符中和) | 0.5.0 刚上逐行 diff 审批视图,未做 Unicode 中和 | **缺失,小改动高安全价值** |
| 多 agent teams(coordinator + 持久团队状态 + 依赖链) | 有 `/api/subagent/parallel` + `AgentParallel`(一层并发,无 coordinator 递归/持久状态);任务中心可做看板骨架 | 半缺 |
| computer use / 浏览器自动化 | 有 Chromium 依赖 + CDP smoke 基建,无面向用户的受控 browser-use 工具 | 缺(需严格 egress + 审批) |
| 定时任务云端/离线运行 | 有本地 scheduler(cron/fireAt),依赖 host 进程存活 | 差距为"服务端常驻",与本地优先定位冲突,降级为 host 常驻自启即可 |
| 消息平台/webhook 触发 | 无 | 缺,但当前 fail-closed egress 下属长期项 |
| ACP(Agent Client Protocol)互操作 | 无 | 缺,观察项 |
| 多表面(web/移动/远程) | 仅本机 loopback + guest 登录 | 与当前安全边界冲突,长期项 |
| 持久记忆 | 五层记忆 + MASE 桥接 + DLP,已强于多数竞品 | 基本无差距 |
| MCP、评测回放、注入防护、沙箱 | 四层 MCP、eval replay、InjectionGuard、Docker 沙箱均已有 | 基本无差距 |

## 3. 改进项与优先级

### P0(小改动、高价值,先做)

**P0-1 审批预览 Unicode 反欺骗中和**
- 内容:在审批卡片(尤其 0.5.0 新 diff 视图)渲染前,对工具输入中的双向覆盖符(U+202A–U+202E、U+2066–U+2069)、零宽字符(U+200B–U+200D、U+FEFF)、形近引号做可见化转义,防止工具参数在视觉上篡改审批语义(Claude Code 2.1.211 同类修复)。
- 落点:host L0 `security/`(新增 `approval-text-neutralize.ts` 纯函数)+ UI diff 渲染处调用;不改审批协议。
- 验收:特征测试钉住现有 diff 输出;新增含 bidi/零宽注入样例的单测;`npm run check` 绿。

**P0-2 后台任务通知防伪造审批**
- 内容:子代理/并行任务回填主循环的生命周期消息统一带"系统生成、未发生人类审批"标记,InjectionGuard 增加对"伪造审批回执"模式的检测(Claude Code 2.1.205 同类加固)。
- 落点:L1 `engine/safety/` + L2 `runtime/`(subagent 事件包装)。
- 验收:红队 eval 集加一条伪造审批注入任务,replay 回放必须拒绝。

### P1(生态与核心体验)

**P1-1 Agent Skills(SKILL.md)开放标准支持** ⭐ 本轮最大杠杆
- 内容:host 支持从 trusted root 下 `\.AgentCowork/skills/<name>/SKILL.md` 加载标准格式 skill(YAML frontmatter `name`/`description` + Markdown 指令);第一阶段只做"指令注入"(渐进式披露:目录级仅注入 name+description,命中再读全文),**不执行 skill 附带脚本**;脚本执行留待第二阶段走 sandbox + 审批。
- 价值:接入 40 家工具共用的格式与 52.5 万+ 现成 skills 生态;自有 recipes 与 skills 互补(recipe=固定产出流水线,skill=知识注入)。
- 落点:L1 `skills/`(新增 `skill-md-loader.ts`、`skill-md-injector.ts`),L2 注入点复用 memory 注入缝;UI 设置页列出已发现 skills + 启停开关。
- 安全:skill 文件属 untrusted 输入,注入前过 InjectionGuard 标记为不可信数据块;路径过 path jail;禁 symlink 逃逸。
- 验收:golden eval 加"命中 skill 指令后行为改变"用例;含恶意指令 skill 的红队用例必须不提权。

**P1-2 任务中心从只读升级为可交互后台任务面板**
- 内容:对标 Claude Code agents 视图/Cowork 后台会话——run 可后台化(前台关闭对话流不终止 run);任务卡显示状态词(running/blocked-on-approval/failed/done)与一句话进展;点击卡片可 attach 回看事件流、直接在卡片上响应待审批项;崩溃后从 checkpoint 恢复的 run 也出现在面板。
- 落点:L2 `runtime/`(run 生命周期与 SSE 订阅解耦)、L3 `routes/`(tasks API 增 attach/approve)、UI 任务中心组件。
- 验收:smoke 新增"发起 run→关闭页面→重开→attach→审批→完成"闭环;`smoke:plan-loop` 断言不回归。

**P1-3 权限模式增强:分类器 + always-allow 持久规则**
- 内容:`guarded_auto` 之上,允许用户对单条工具+参数模式点"本工作区总是允许",规则持久化到工作区级配置(对标 Claude Code 2.1.211 的仓库根持久授权);可选:用本地小模型对灰区工具调用做二次分类(无本地模型时退回静态分类,不引入云依赖)。
- 落点:L2 `runtime/approvals` + 存储适配器;UI 审批卡加"总是允许"入口。
- 验收:特征测试钉死现有三档行为;新增规则命中/不命中/跨工作区不泄漏用例。

### P2(能力扩展)

**P2-1 多 agent teams:coordinator 模式 + 依赖链**
- 内容:对标 Cline teams/Kanban——在 `AgentParallel` 之上加 coordinator 子代理(拆解→委派→汇总),团队状态(子任务清单、依赖边、各自结论)持久化到 run record,任务中心以看板列渲染依赖链;子任务写操作仍全部走主审批流。
- 落点:L2 `orchestrator/`(已有 workflow-runner 骨架可扩展)。

**P2-2 受控浏览器自动化(computer use 第一步)**
- 内容:对标 Cowork computer-use 预览/Manus——新增 `browser` 工具组(打开页面/读取/截图/受审批的表单填写),走本机 Chromium CDP(基建已在 rendered-ui smoke 中);工具风险类固定为 `network_external`,受 egress 网关与安全档位约束(`local_strict`/`air_gap` 自动禁用),每次导航记审计。
- 落点:L1 `tools/`(新 browser 工具)+ `security/egress-gateway` 策略点复用。

### P3(观察/长期,当前不做)

- 消息平台(钉钉/飞书/Slack)与 webhook 触发:等公网审批回执消费链验收后再启动,否则与 fail-closed egress 冲突。
- ACP 互操作(把引擎暴露为 ACP server 供 OpenHands 等前端复用):跟踪标准成熟度。
- web/移动多表面与远程会话:与"仅本机 loopback"安全承诺冲突,需先完成鉴权强化(替换 guest 公开登录)再评估。
- 定时任务"无设备在线"云端运行:与本地优先定位冲突,以"host 常驻自启 + 错过补跑"替代。

## 4. 执行约定

- 顺序:P0-1 → P0-2 → P1-1 → P1-2 → P1-3 → P2;深度优先,一条线完成(测试绿 + 证据)再开下一条。
- 每条线开工前:先读所涉模块现有测试,补特征测试钉住现状;新文件遵守 `check:arch` 分层与 `check:filesize` 上限。
- 本计划为路线文档,不构成任何"已完成"声明;各条目完成判定以 `python -X utf8 scripts/quality_gate.py --level full` 当次输出 + 对应 smoke/eval 证据为准。
