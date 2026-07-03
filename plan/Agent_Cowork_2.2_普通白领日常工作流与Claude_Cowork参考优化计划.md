# Agent Cowork 2.2 优化计划：普通白领日常工作流与 Claude Cowork 参考方案

> 版本：v0.1  
> 日期：2026-07-02  
> 建议文件路径：`docs/Agent-Cowork-2.2-普通白领日常工作流与Claude-Cowork参考优化计划.md`  
> 目标读者：产品、前端、Host 后端、Agent Runtime、连接器、插件生态、安全、测试  
> 关键词：普通白领、日程、邮件、会议、表格、PPT、WPS/Office、飞书/钉钉/企业微信、周期任务、Live Artifacts、Dispatch、项目空间、审批、安全、记忆

---

## 0. 一句话结论

Agent Cowork 下一阶段不应该只继续强化“模型、记忆、能力包、Hook、安全”，还应该补齐 **普通白领每天真正会用的工作入口**：

> **今天要处理什么、哪些邮件/群消息需要回复、会议前要准备什么、会议后要跟进什么、表格和 PPT 怎么快速产出、哪些任务可以每天/每周自动跑、哪些产物可以持续刷新成仪表盘。**

参考 Claude Cowork 后，最值得借鉴的不是单个技术点，而是它把 AI 从“聊天框”变成了 **桌面工作委派系统**：用户从桌面、移动端、Slack/Office/浏览器等入口派活；系统按项目隔离文件、上下文、指令和记忆；周期任务按时产出日报/周报/简报；Live Artifacts 把一次性结果升级为可持续刷新的仪表盘；Office/Outlook 场景强调跨应用上下文，但邮件和邀请必须停留在草稿等待人工审阅。

Agent Cowork 2.2 的目标是把产品从“本地 Agent 工作台”升级为：

> **面向中文办公环境的 Local-First 白领工作助理：能从日程、邮件、会议、文档、表格、群聊和本地文件中形成任务，先起草、先预览、先审批，再生成文件或执行动作。**

---

## 1. 这次补的是“用户每天会打开”的产品层

前两版方案已经覆盖：

- SaaS 化、本地优先、安全与保密。
- 国产模型配置、新手教学、Skills / Recipes / Hooks。
- 记忆、兜底、按需安装、岗位能力包、缓存命中、Design 插件。

但普通白领不会因为“支持 MCP、Hooks、ModelRouter、MemoryCore”而每天打开产品。他们会因为以下需求打开：

1. 今天会议很多，想提前拿到会议简报。
2. 邮件/群消息太多，想知道哪些需要自己处理。
3. 上级要周报，想自动汇总本周工作。
4. 客户发了材料，想快速生成回复、方案和报价表。
5. 老板要 PPT，想从文件夹资料一键生成初稿。
6. 表格很乱，想自动清洗、归类、出图、找异常。
7. 项目资料散在文件夹、WPS、飞书、钉钉、企业微信、腾讯文档里，想统一查询和整理。
8. 每天都要做重复性报告，想设置成定时任务。
9. 经常忘记上次跟某客户/项目聊到哪，希望跨窗口记住进展。
10. 希望 AI 不乱发邮件、不乱改文件、不乱碰敏感应用。

因此，2.2 的产品主线是：

```txt
从“技术能力中心”转向“白领工作日中心”。
```

---

## 2. Claude Cowork 可继续参考的关键机制

> 原则：借鉴机制，不照搬品牌、文案、界面或商业标识。

### 2.1 Projects：项目空间是普通用户理解上下文的最好方式

Claude Cowork 的 Projects 将任务分组到独立工作区，每个项目有自己的文件、上下文、指令和记忆；对 Agent Cowork 的启发是：不要让用户管理“上下文窗口”，而是让用户管理“项目”。

Agent Cowork 应新增：

```txt
项目空间 Project Space
  ├─ 项目文件夹 / 本地路径
  ├─ 项目说明 / 目标 / 角色
  ├─ 项目联系人 / 客户 / 关键词
  ├─ 项目记忆
  ├─ 项目任务
  ├─ 项目产物
  ├─ 项目周期任务
  ├─ 项目连接器授权
  └─ 项目安全策略
```

普通白领不应看到“向量库、memory scope、context key”，而应看到：

```txt
这是“华东客户续约项目”。
Agent Cowork 已记住：客户名称、合同周期、上次会议结论、常用汇报格式、负责人偏好。
```

### 2.2 Scheduled Tasks：周期任务是白领场景的高频刚需

Claude Cowork 的周期任务用于日报、周报、简报、研究跟踪等自动产出。Agent Cowork 应把 Scheduled Tasks 做成本地优先、安全可控的核心功能，而不是高级功能。

典型周期任务：

| 任务 | 频率 | 输入 | 输出 |
|---|---:|---|---|
| 每日工作简报 | 每天 8:30 | 日历、邮件、群消息、待办 | 今日重点、会议准备、风险提醒 |
| 每日收尾总结 | 每天 18:00 | 当天任务、产物、会议纪要 | 今日完成、未完成、明日建议 |
| 周报生成 | 每周五 | 项目任务、文档、会议、产物 | 周报 Markdown / DOCX / PPT |
| 客户跟进提醒 | 每天/每周 | CRM 表格、邮件、聊天记录 | 需跟进客户列表 |
| 竞品/行业跟踪 | 每周 | 订阅源、网页、文件夹 | 竞品动态仪表盘 |
| 报销/发票整理 | 每月 | 发票文件夹、Excel | 报销清单和异常项 |

安全边界：

```txt
周期任务默认只能读和生成草稿。
周期任务不得自动发送邮件、消息、邀请、合同、报价、付款、删除文件。
任何外发、覆盖、删除、付款、签署类动作必须转为“待审批”。
```

### 2.3 Dispatch：从任何地方派活

Claude Cowork 的 Dispatch 思路是：用户不必回到主界面才能派任务。Agent Cowork 应支持：

```txt
- 全局快捷键：Ctrl/Command + Shift + Space
- 系统托盘快速输入
- 右键菜单：选中文件/文件夹 → 交给 Agent Cowork
- 剪贴板入口：复制文字/表格/截图后快速处理
- 浏览器插件：当前网页总结、表单草稿、竞品页监控
- Office/WPS 插件：当前文档/表格/PPT 直接派活
- 飞书/钉钉/企业微信机器人：群内 @Agent 创建任务
- 手机端轻入口：发送一句话给桌面任务队列
```

所有入口最终进入同一个 `Task Inbox`，并显示：

```txt
来源：Chrome / WPS / Excel / 飞书 / 本地文件 / 快捷键
范围：允许读取哪些文件或页面
动作：只读总结 / 草稿生成 / 文件写入 / 外发待审批
状态：待确认 / 运行中 / 等待审批 / 已完成
```

### 2.4 Live Artifacts：从一次性文件到持续刷新的工作面板

Claude Cowork 的 Live Artifacts 是可持续打开、刷新、迭代和版本化的 HTML 仪表盘。Agent Cowork 可以做本地优先版本：

```txt
Live Artifact = 本地持久化交互式产物
  - 可以是 HTML 仪表盘、任务看板、客户跟进表、项目风险图、竞品追踪页
  - 数据源来自用户授权的本地文件/连接器
  - 每次刷新写入版本历史
  - 可以导出为 HTML / PDF / PNG / Markdown
  - 默认只读刷新；写回源数据需要审批
```

适合普通白领的 Live Artifacts：

1. 今日工作驾驶舱。
2. 项目风险看板。
3. 客户跟进看板。
4. 周报素材收集器。
5. 发票/报销异常面板。
6. 会议行动项追踪面板。
7. 竞品动态追踪面板。
8. 招聘候选人漏斗。
9. 合同到期提醒面板。
10. 跨表格 KPI 面板。

### 2.5 Office / WPS / Outlook 式跨应用上下文

Claude for Outlook 的一个关键启发是：邮件线程、Word、Excel、PowerPoint 可以共享上下文，用户无需复制粘贴。但它同时强调草稿必须由用户审阅，尤其是收件人和外发内容。

Agent Cowork 应在中国办公环境里做类似能力：

```txt
跨应用上下文 Context Bridge
  - 邮件线程 → Word 合同/方案 → Excel 报价/预算 → PPT 汇报
  - 飞书/钉钉群聊 → 云文档 → 日历会议 → 待办任务
  - 腾讯会议录制/纪要 → 项目行动项 → 周报
  - 本地文件夹 → WPS 文档 → PDF 输出
```

核心原则：

```txt
AI 可以起草，但不能自动代表用户发送。
AI 可以预填，但不能自动提交高影响表单。
AI 可以生成邀请草稿，但不能自动邀请外部人。
AI 可以修改副本，但不能无预览覆盖原件。
```

### 2.6 Computer Use：屏幕自动化只能作为最后兜底

Claude Cowork 的 computer use 能直接操作桌面应用，但官方安全说明也强调它没有普通文件操作那样的沙箱。Agent Cowork 不建议一开始主推屏幕控制，而应分层：

```txt
优先级 1：本地文件/API/连接器/MCP 直接操作，最安全、最快、可审计。
优先级 2：Office/WPS/浏览器插件内受控操作，作用域清晰。
优先级 3：RPA/屏幕自动化，只用于没有 API 的应用，且必须录屏/截图/逐步审批。
```

对普通白领的设计：

```txt
不要叫“Computer Use”。
叫“帮我操作这个应用（预览版）”。
默认关闭，只允许用户显式选择的应用窗口。
所有输入、点击、复制、提交动作写入时间线。
提交、发送、删除、付款、签署、导出联系人等动作必须停下等待用户。
```

### 2.7 Custom Visuals：把解释变成图，而不是长文

普通白领经常需要“给我一个图”。Agent Cowork 应内置视觉产物类型：

```txt
- 流程图
- 甘特图
- 项目风险矩阵
- 组织架构图
- 漏斗图
- 对比卡片
- 决策矩阵
- 时间线
- 会议行动项看板
- KPI 趋势图
```

这可以复用已有 DesignPlugin 与 artifact 面板，但要在 UI 上产品化成：

```txt
“生成图表 / 生成看板 / 生成时间线 / 生成汇报图”
```

### 2.8 Connectors + Skills：工具接入和做事方法要分开

Claude 的 Skills 与 MCP/Connectors 分工清晰：Connector 负责访问工具和数据，Skill 负责告诉模型如何完成特定任务。Agent Cowork 应继续坚持：

```txt
Connector = 能访问什么
Skill = 怎么做
Recipe = 完整流程
Hook = 什么不能做 / 什么必须审批
```

对普通白领尤其重要，因为“能访问飞书/钉钉/WPS”不等于“会写一份合格周报”。周报、会议纪要、客户跟进、表格清洗、PPT 汇报都应是 Skills / Recipes。

---

## 3. 你可能还没想到的 24 个功能方向

以下是建议补进产品规划的方向，优先考虑普通白领日常工作，而不是开发者或安全专家。

| 编号 | 功能方向 | 为什么重要 | 优先级 |
|---:|---|---|---|
| 1 | 今日工作驾驶舱 | 用户每天打开就知道先做什么 | P0 |
| 2 | 任务收件箱 Task Inbox | 所有派活入口统一管理，避免任务散落 | P0 |
| 3 | 邮件/群消息优先级整理 | 白领最大痛点是信息过载 | P0 |
| 4 | 会议前简报 | 会议前自动准备背景、议程、历史结论 | P0 |
| 5 | 会议后行动项 | 把会议纪要转成待办、责任人、截止日期 | P0 |
| 6 | 周报/月报自动生成 | 高频重复、价值明显 | P0 |
| 7 | 草稿不发送策略 | 白领场景最大风险是误发、错发、越权发 | P0 |
| 8 | 项目空间 | 普通用户理解上下文和记忆的最佳载体 | P0 |
| 9 | Live Artifact 仪表盘 | 让产物可持续复用，不只是一次性文件 | P1 |
| 10 | 飞书/钉钉/企业微信入口 | 中文办公生态必备 | P1 |
| 11 | WPS/金山文档/腾讯文档连接器 | 大陆白领常用文档生态 | P1 |
| 12 | Outlook/本地邮件/企业邮箱适配 | 邮件仍是商务协作核心 | P1 |
| 13 | 日历与会议室 | 会议安排、冲突检测、提醒 | P1 |
| 14 | 模板库/企业写作风格 | 普通用户不想反复写 prompt | P1 |
| 15 | 表格清洗与异常检测 | 行政、财务、运营、销售都高频 | P1 |
| 16 | PPT 初稿与一键美化 | 办公刚需，付费意愿高 | P1 |
| 17 | 客户/项目 360 摘要 | 销售、客服、项目经理高频 | P1 |
| 18 | 多版本产物与变更对比 | 避免 AI 改坏文档 | P1 |
| 19 | “为什么这么建议”来源引用 | 增强信任，减少幻觉风险 | P1 |
| 20 | 通知中心 | 所有待审批、失败、周期任务结果集中显示 | P1 |
| 21 | 移动端轻派活 | 手机上想到任务，交给电脑执行 | P2 |
| 22 | 浏览器网页监控 | 竞品、招标、政策、客户官网变化跟踪 | P2 |
| 23 | 屏幕自动化兜底 | 没有 API 的系统也能辅助，但风险高 | P2 |
| 24 | 团队共享模板与审计 | 小团队/企业版商业化关键 | P2 |

---

## 4. Agent Cowork 2.2 产品定位

### 4.1 新定位

> **Agent Cowork 2.2：面向普通白领的本地优先 AI 工作助理。它帮你处理日程、邮件、会议、文档、表格、PPT、群聊和项目资料，但所有高风险动作都会先给你看、等你批。**

### 4.2 不做什么

为了避免产品失控，2.2 明确不做：

```txt
- 不做自动代发邮件/微信/飞书/钉钉消息。
- 不做自动付款、下单、签署、投资、医疗、法律结论。
- 不默认读取全盘文件。
- 不默认调用屏幕自动化控制所有应用。
- 不默认把本地文件发给公网模型。
- 不用“AI 替你判断一切”，而是“AI 帮你整理、起草、提示、预览”。
```

### 4.3 核心卖点

```txt
1. 本地优先：文件和产物默认留在本地工作区。
2. 白领友好：从日程、邮件、会议、表格、PPT、群聊开始，不从技术概念开始。
3. 先草稿后审批：外发、覆盖、删除、提交都必须确认。
4. 项目记忆：按项目记住偏好、进展、联系人和历史结论。
5. 周期任务：日报、周报、客户跟进、竞品追踪可定时生成。
6. 活产物：仪表盘、看板、追踪器可以刷新和版本化。
7. 中文办公生态：WPS、金山文档、腾讯文档、飞书、钉钉、企业微信、腾讯会议优先。
8. 可扩展：Connector 访问工具，Skill 教会流程，Recipe 端到端执行，Hook 控制风险。
```

---

## 5. 目标用户与岗位场景

### 5.1 通用白领

需求：整理信息、写邮件、做会议纪要、出周报、做表格、做 PPT。

推荐入口：今日工作驾驶舱、任务收件箱、周期任务、文件夹总结。

### 5.2 行政 / 助理 / 办公室

高频任务：

```txt
- 日程安排
- 会议室预定
- 会议纪要
- 参会名单整理
- 通知草稿
- 文件归档
- 报销材料初审
- 制度文件问答
```

能力包：`role-admin-assistant`。

### 5.3 销售 / 客户成功

高频任务：

```txt
- 客户沟通记录总结
- 下次跟进建议
- 报价表初稿
- 客户方案 PPT
- 竞品对比
- CRM 表格更新草稿
- 合同到期提醒
```

能力包：`role-sales-cs`。

### 5.4 项目经理 / 运营

高频任务：

```txt
- 项目周报
- 风险清单
- 里程碑追踪
- 会议行动项
- 跨部门同步材料
- 数据看板
- SOP 文档维护
```

能力包：`role-project-ops`。

### 5.5 HR / 招聘

高频任务：

```txt
- 简历初筛摘要
- 面试安排
- 候选人对比表
- 面试纪要
- offer 材料草稿
- 入职资料检查
- 培训反馈汇总
```

能力包：`role-hr-recruiting`。

### 5.6 财务 / 采购 / 报销协同

高频任务：

```txt
- 发票文件整理
- 报销清单生成
- 异常金额提示
- 供应商报价对比
- 合同付款节点提醒
- 月度费用汇总
```

能力包：`role-finance-procurement-assist`。

注意：此能力包只做资料整理、表格处理、异常提示、草稿生成；不做付款、投资、税务/审计/法律结论。

---

## 6. 总体架构升级

### 6.1 新增中台

在 2.1 的基础上新增 8 个白领工作中台：

```txt
WorkdayHub          今日工作驾驶舱
TaskInbox           任务收件箱 / 派活队列
Scheduler           周期任务调度器
ContextBridge        跨应用上下文桥
LiveArtifactEngine   活产物 / 仪表盘引擎
OfficeDocEngine      Office/WPS/文档表格演示处理引擎
CommsDraftEngine     邮件/群消息/会议邀请草稿引擎
ActionGuard          外发、覆盖、删除、提交等动作保护
```

总体架构：

```txt
┌──────────────────────────────────────────────────────────────────────┐
│                          Agent Cowork UI                              │
│ Workday │ Inbox │ Projects │ Scheduled │ Live Artifacts │ Approvals    │
│ Docs    │ Sheets│ Meetings │ Connectors│ Memory         │ Settings      │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────────┐
│                         Host API / Control Plane                      │
│ TaskInbox │ ProjectSpace │ Scheduler │ ConnectorHub │ ActionGuard     │
│ MemoryCore│ CacheService │ Fallback  │ PolicyEngine │ Audit/Rollback   │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────────┐
│                          Agent Runtime                                │
│ ModelRouter │ Skills │ Recipes │ Hooks │ Subagents │ ContextBuilder    │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────────┐
│                           Tools / Connectors                          │
│ Local Files │ WPS │ Office │ Feishu │ DingTalk │ WeCom │ Tencent Docs  │
│ Browser │ Email │ Calendar │ Meeting │ CRM CSV │ Local DB │ MCP         │
└──────────────────────────────────────────────────────────────────────┘
```

### 6.2 任务生命周期

```txt
Capture 捕获任务
  ↓
Classify 分类：邮件 / 会议 / 文档 / 表格 / PPT / 周报 / 项目 / 客户
  ↓
Scope 确认作用域：读取哪些文件/应用/日期范围/项目
  ↓
Plan 生成计划
  ↓
Approve 用户审批或转为只读草稿
  ↓
Execute 执行工具/连接器/文档生成
  ↓
Verify 自检：来源引用、文件读回、格式校验、敏感信息扫描
  ↓
Publish 生成本地产物或外发草稿
  ↓
Remember 写入项目记忆和任务历史
  ↓
Review 展示结果、待办、下一步建议
```

---

## 7. 新首页：Workday Hub 今日工作驾驶舱

### 7.1 目标

用户打开 Agent Cowork 时，第一眼不应该看到“空聊天框”，而应看到：

```txt
今天你需要关注的 5 件事。
```

### 7.2 页面结构

```txt
┌──────────────────────────────────────────┐
│ 早上好，今天是 2026-07-02 周四            │
│ 当前模式：本地严格 / 混合可控 / 云端增强    │
├──────────────────────────────────────────┤
│ 今日重点                                  │
│ 1. 10:00 客户续约会：缺少上次会议纪要       │
│ 2. 14:00 周例会：需要准备项目进度页         │
│ 3. 有 6 封邮件可能需要回复                 │
├──────────────────────────────────────────┤
│ 快捷任务                                  │
│ [生成今日会议简报] [整理昨天产物] [生成周报] │
│ [提取待办] [清洗表格] [做PPT初稿]          │
├──────────────────────────────────────────┤
│ 待审批                                    │
│ - 将创建 周报.docx                         │
│ - 将生成 3 封邮件草稿                       │
├──────────────────────────────────────────┤
│ 最近项目                                  │
│ 华东客户续约｜招聘项目｜Q3预算｜产品发布      │
└──────────────────────────────────────────┘
```

### 7.3 数据来源

```txt
- 本地项目任务历史
- 已授权日历
- 已授权邮件/群消息摘要
- 本地文件最近修改
- 周期任务结果
- 用户手动置顶项目
- MemoryCore 中的近期承诺和偏好
```

### 7.4 安全默认值

首次启用 Workday Hub 时：

```txt
- 不自动连接外部应用。
- 不自动读取全盘。
- 只显示本地 demo / 最近 Agent Cowork 项目。
- 用户逐项授权日历、邮件、文档、群聊。
```

---

## 8. Task Inbox：所有派活入口统一收敛

### 8.1 为什么需要 Task Inbox

如果支持快捷键、右键菜单、浏览器、Office/WPS、飞书、钉钉、企业微信、移动端，那么任务会从很多地方进来。没有收件箱，用户会失控。

### 8.2 TaskInbox 数据结构

```ts
type TaskInboxItem = {
  id: string
  title: string
  source: 'desktop_hotkey' | 'tray' | 'context_menu' | 'browser' | 'office' | 'wps' | 'feishu' | 'dingtalk' | 'wecom' | 'mobile' | 'manual'
  sourceApp?: string
  projectId?: string
  capturedAt: string
  userIntent: string
  capturedContext: {
    textSnippet?: string
    selectedFiles?: string[]
    selectedFolder?: string
    pageUrl?: string
    messageThreadRef?: string
    emailThreadRef?: string
    calendarEventRef?: string
    screenshotPath?: string
  }
  suggestedRecipe?: string
  requiredPermissions: PermissionRequest[]
  riskLevel: 'low' | 'medium' | 'high'
  status: 'new' | 'needs_scope' | 'ready_to_plan' | 'planned' | 'waiting_approval' | 'running' | 'done' | 'cancelled'
}
```

### 8.3 UX 规则

```txt
- 新任务默认不自动执行，先进入“待确认”。
- 如果来源是外部 IM 群聊，只允许生成草稿或本地任务，不自动外发。
- 如果来源是浏览器网页，必须标记网页 URL 和抓取时间。
- 如果来源是文件右键，作用域默认只限被选中文件/文件夹。
- 如果来源是手机，桌面端必须弹出确认，因为真实文件在电脑上。
```

---

## 9. Project Space：把“跨窗口记忆”落到项目

### 9.1 项目空间字段

```ts
type ProjectSpace = {
  id: string
  name: string
  description?: string
  localRoot: string
  instructionsPath?: string
  privacyMode: 'local_strict' | 'hybrid_controlled' | 'cloud_enhanced'
  defaultModelPolicy: string
  connectors: ProjectConnectorBinding[]
  memoryScope: {
    enabled: boolean
    allowCrossWindow: boolean
    allowGlobalPreference: boolean
    excludedTopics: string[]
  }
  artifactsRoot: string
  scheduleIds: string[]
  ownerUserId: string
  createdAt: string
  updatedAt: string
}
```

### 9.2 项目创建方式

```txt
1. 从本地文件夹创建。
2. 从已有 Agent Cowork 任务创建。
3. 从模板创建：客户项目 / 周报项目 / 招聘项目 / 报销项目 / 竞品追踪。
4. 从连接器创建：飞书文档空间、钉钉项目群、企业微信群、WPS/腾讯文档文件夹。
```

### 9.3 项目记忆卡片

UI 中应显示：

```txt
项目记住了：
- 本项目汇报对象偏好：先结论后数据，少用长段落。
- 常用输出格式：周报包含“进展、风险、下周计划”。
- 最近会议结论：客户希望 7 月底前给出续约报价。
- 当前待办：报价表、续约方案、技术问题清单。
```

每条记忆必须可：

```txt
查看来源 → 编辑 → 删除 → 禁用 → 导出。
```

---

## 10. Scheduled Tasks：周期任务设计

### 10.1 Scheduler 数据结构

```ts
type ScheduledTask = {
  id: string
  projectId?: string
  title: string
  description: string
  recipeId: string
  cron: string
  timezone: string
  enabled: boolean
  runWhenComputerAwakeOnly: boolean
  allowedSources: DataSourceScope[]
  allowedActions: AllowedAction[]
  approvalPolicy: 'always_preview' | 'auto_read_only' | 'auto_generate_draft' | 'manual_only'
  outputTarget: 'artifact' | 'live_artifact' | 'draft_email' | 'draft_message' | 'local_file'
  lastRunAt?: string
  nextRunAt?: string
  failurePolicy: 'notify_only' | 'retry_then_notify' | 'disable_after_n_failures'
}
```

### 10.2 P0 内置周期任务模板

#### 每日简报

```txt
名称：每日工作简报
时间：工作日 08:30
输入：今天日历、昨天未完成任务、重要邮件/群消息摘要、项目记忆
输出：今日工作简报.md + Workday Hub 卡片
动作：只读 + 本地生成
```

#### 每日收尾

```txt
名称：每日收尾总结
时间：工作日 18:00
输入：当天 Agent Cowork 任务、产物、会议行动项、用户确认的完成状态
输出：今日总结.md + 明日待办草稿
动作：只读 + 本地生成
```

#### 每周周报

```txt
名称：周报生成
时间：周五 16:00
输入：本周项目产物、会议纪要、任务状态、用户补充说明
输出：周报.docx / 周报.pptx / 周报.md
动作：生成草稿，不外发
```

#### 客户跟进

```txt
名称：客户跟进提醒
时间：每天 09:00
输入：客户表、最近邮件/会议纪要、上次跟进时间
输出：客户跟进看板 Live Artifact
动作：只读 + 看板刷新
```

### 10.3 周期任务安全策略

```txt
- 第一次运行必须人工确认。
- 任务变更数据源或动作范围后必须重新确认。
- 连续失败 N 次自动暂停。
- 读取外部连接器时必须记录数据源、时间范围和权限摘要。
- 输出必须保留版本。
- 外发动作永远进入待审批，不允许定时自动发送。
```

---

## 11. Live Artifacts：白领场景的活产物

### 11.1 数据结构

```ts
type LiveArtifact = {
  id: string
  projectId?: string
  title: string
  type: 'dashboard' | 'tracker' | 'comparison' | 'timeline' | 'report' | 'chart' | 'reference'
  artifactPath: string
  dataSources: DataSourceScope[]
  refreshPolicy: 'manual' | 'scheduled' | 'on_source_change'
  versionHistory: LiveArtifactVersion[]
  permissions: {
    canReadSources: boolean
    canWriteBack: boolean
    writeBackRequiresApproval: boolean
  }
  createdAt: string
  updatedAt: string
}
```

### 11.2 首批 Live Artifact 模板

| 模板 | 面向用户 | 数据源 | 输出 |
|---|---|---|---|
| 今日工作驾驶舱 | 所有人 | 日历、任务、邮件摘要 | HTML 看板 |
| 项目风险看板 | 项目经理 | 会议纪要、周报、任务表 | 风险矩阵 |
| 客户跟进看板 | 销售/CS | 客户表、邮件摘要、会议纪要 | 跟进列表 |
| 周报素材池 | 所有人 | 本周文件、任务、会议 | 可编辑素材清单 |
| 竞品追踪器 | 市场/产品 | 网页、RSS、文档 | 变化时间线 |
| 发票异常看板 | 行政/财务协同 | 发票文件夹、报销表 | 异常项列表 |
| 招聘漏斗 | HR | 简历、面试表、日历 | 候选人状态看板 |

### 11.3 技术实现建议

```txt
- Live Artifact 采用本地 HTML + JSON 数据包。
- HTML 只允许访问同目录 data.json，不直接联网。
- 刷新由 Host 生成新的 data.json 和 version manifest。
- UI 用 iframe sandbox 预览。
- 图表库按需安装，不进核心包；没有图表库时降级为表格视图。
```

### 11.4 文件结构

```txt
.AgentCowork/
  live-artifacts/
    customer-followup-dashboard/
      artifact.html
      data.json
      manifest.json
      versions/
        2026-07-02T083000Z.data.json
        2026-07-02T083000Z.snapshot.png
```

---

## 12. 连接器策略：中国白领生态优先

### 12.1 连接器优先级

P0：本地无外部账号

```txt
- 本地文件夹
- 本地 Markdown / TXT / CSV / XLSX / DOCX / PPTX / PDF
- 剪贴板
- 截图
- 浏览器当前页手动导入
```

P1：办公文档和通讯

```txt
- WPS / 金山文档
- 腾讯文档
- 飞书
- 钉钉
- 企业微信
- 腾讯会议
- Outlook / 企业邮箱 / IMAP
- 本地 Office / WPS 文件
```

P2：团队和业务系统

```txt
- Jira / Trello / Linear / Asana / 禅道
- CRM CSV / 飞书多维表格 / 金山轻维表 / 腾讯文档智能表
- OA / ERP / 采购系统 / 报销系统：先通过 CSV/Excel 导入，后续再做 API
```

### 12.2 连接器统一抽象

```ts
type ConnectorManifest = {
  id: string
  displayName: string
  category: 'file' | 'docs' | 'email' | 'calendar' | 'im' | 'meeting' | 'crm' | 'browser' | 'office' | 'custom'
  authType: 'none' | 'oauth2' | 'device_code' | 'api_key' | 'webhook' | 'local_app'
  scopes: ConnectorScope[]
  capabilities: ConnectorCapability[]
  riskProfile: {
    canRead: boolean
    canWrite: boolean
    canSendExternal: boolean
    canDelete: boolean
    canInvite: boolean
    canSubmitForm: boolean
  }
  install: {
    bundled: boolean
    packageId?: string
    minVersion?: string
  }
}
```

### 12.3 作用域原则

```txt
- 邮件连接器默认只读主题、发件人、时间和用户选中的邮件正文。
- 群聊连接器默认只读用户指定群、指定时间范围。
- 文档连接器默认只读用户选择的文件夹或文档。
- 日历连接器默认只读未来 7 天和过去 7 天，可配置。
- 会议连接器默认只读用户选择的会议纪要/录制转写。
- 任何写入、发消息、邀请、删除、分享链接都必须单独 scope + 单次审批。
```

### 12.4 国产办公连接器说明

#### 飞书 / Lark

飞书开放平台覆盖 IM、云文档、云盘、电子表格、多维表格、日历、邮件、通讯录、任务、事件、视频会议等能力。Agent Cowork 应优先做“只读摘要 + 草稿生成 + 待办提取”，再做写入。

建议首批能力：

```txt
- 读取指定群最近消息摘要
- 读取指定云文档/文件夹
- 读取日历事件
- 生成飞书消息草稿
- 提取任务并生成本地待办
```

#### 钉钉

钉钉开放平台有消息、机器人、日程、组织、文档等企业能力。Agent Cowork 初期不要直接做复杂企业管理动作，应优先做群消息总结、机器人通知草稿、会议/任务摘要。

#### 企业微信

企业微信常见落地方式是企业自建应用或群机器人。初期建议只做：

```txt
- 企业微信群 webhook 通知草稿
- 选定群消息摘要，若官方权限不可用则使用导出文件/手动粘贴方式
- 客户跟进提醒生成，不自动触达客户
```

#### WPS / 金山文档

金山文档开放平台包含个人文档、应用文档、文档内容编撰、格式转换、匿名预览、AirScript 等能力。Agent Cowork 应重点做文档读取、转换、表格处理、预览和模板填充。

#### 腾讯文档

腾讯文档开放平台提供 HTTP Open API、文档资源访问、协作编辑、小程序、MCP、WebSDK 等能力。Agent Cowork 可以作为腾讯文档 MCP/Connector 的客户端。

#### 腾讯会议

腾讯会议开放平台支持会议预定、会议控制、会议室、会中互动、会议沉淀管理、云录制、投票等能力。Agent Cowork 白领版重点是：

```txt
- 会前简报
- 会后纪要整理
- 行动项提取
- 参会者/录制/转写沉淀
- 跟进邮件或群消息草稿
```

---

## 13. 邮件与消息：必须做“草稿优先”

### 13.1 邮件工作流

普通白领邮件场景非常高频，但风险也很高。Agent Cowork 应设计为：

```txt
读取 → 总结 → 分类 → 起草 → 用户审阅 → 用户手动发送
```

不得设计为：

```txt
读取 → 自动判断 → 自动发送
```

### 13.2 邮件功能

| 功能 | 描述 | 风险策略 |
|---|---|---|
| 邮件线程总结 | 总结邮件来龙去脉 | 引用来源邮件 |
| 回复草稿 | 生成待用户复制/发送的草稿 | 不自动发送 |
| 收件人检查 | 提醒外部收件人、群发、抄送 | 必须人工确认 |
| 附件摘要 | 读取用户选择附件 | 敏感文件提醒 |
| 行动项提取 | 提取待办、负责人、截止日期 | 用户确认后入待办 |
| 会议邀请草稿 | 起草日历邀请 | 不自动邀请外部人 |
| 客户语气调整 | 更正式/更简短/更温和 | 展示修改对比 |

### 13.3 外发前检查清单

在任何邮件/消息/邀请外发前，显示：

```txt
外发前请确认：
- 收件人 / 群聊：xxx
- 是否包含外部人员：是/否
- 是否包含附件：是/否
- 是否包含敏感字段：客户名、金额、合同、身份证、手机号、API Key
- 是否基于哪些来源生成：邮件 A、文档 B、会议纪要 C
- 是否会离开本地：复制到外部应用 / 调用外部 API / 云模型
```

按钮：

```txt
[复制草稿] [打开邮件客户端草稿] [返回修改] [标记为完成]
```

不提供 P0 自动发送按钮。

---

## 14. 会议工作流：会前、会中、会后

### 14.1 会前简报

输入：

```txt
- 日历事件标题、参会人、会议说明
- 相关项目记忆
- 上次会议纪要
- 最近邮件/群消息摘要
- 客户/项目文件夹
```

输出：

```txt
- 会议目的
- 背景摘要
- 需要确认的问题
- 可能风险
- 建议议程
- 上次待办完成情况
- 参会人备注
```

### 14.2 会中辅助

P0 不做实时录音识别，避免隐私复杂度过高。先支持：

```txt
- 用户导入会议文本/转写
- 用户粘贴会议记录
- 从腾讯会议/飞书/钉钉会议连接器读取已授权纪要
```

P1 再做：

```txt
- 本地录音转写能力包
- 说话人识别能力包
- 会议截图 OCR
```

### 14.3 会后行动项

输出结构：

```txt
会议结论：
- ...

行动项：
| 事项 | 负责人 | 截止日期 | 来源句子 | 状态 |

需要跟进的问题：
- ...

建议发送的跟进消息草稿：
- 给内部群：...
- 给客户：...
```

所有跟进消息均为草稿。

---

## 15. 表格工作流：普通白领最容易付费的功能

### 15.1 P0 表格能力

```txt
- CSV/XLSX 读取与预览
- 自动识别字段类型
- 缺失值/重复值/异常值提示
- 按列汇总
- 分组统计
- 生成图表
- 生成自然语言结论
- 导出清洗后副本
```

### 15.2 P1 表格能力

```txt
- 多表合并
- 模糊匹配客户/供应商名称
- 透视表生成
- 公式解释
- 错误公式检查
- 财务/报销异常规则包
- 销售漏斗分析
- 运营日报自动化
```

### 15.3 表格安全

```txt
- 永远先生成副本，不直接覆盖原表。
- 写入前展示变更摘要：新增列、删除列、修改单元格数量。
- 大表处理走本地 duckdb/pandas 能力包，按需安装。
- 云模型只接收 schema、摘要、抽样数据；完整表格外发必须显式确认。
```

---

## 16. PPT / 报告 / 文档工作流

### 16.1 一键 PPT 初稿

用户输入：

```txt
把这个文件夹里的材料整理成 10 页汇报 PPT，面向销售总监，风格简洁，重点突出下周风险。
```

系统流程：

```txt
1. 读取文件夹目录和摘要。
2. 生成 PPT 大纲。
3. 用户确认页数、听众、风格。
4. 生成每页标题、要点、图表建议。
5. 生成 PPTX 副本。
6. 自检：页数、空页、图表数据来源、敏感信息。
7. 产物面板打开。
```

### 16.2 企业模板

```txt
- 支持导入公司 PPT 模板。
- 支持设置常用汇报结构。
- 支持记忆领导偏好。
- 支持 DesignPlugin 检查视觉一致性。
```

### 16.3 文档版本

```txt
每次生成报告，都保留：
- 来源文件列表
- prompt / 任务说明摘要
- 模型和本地工具版本
- 输出版本
- 变更 diff
- 可回滚副本
```

---

## 17. 白领 Role Packs：不要只按技术能力分类

2.1 已经提出 Capability Pack，但普通用户更容易理解“岗位包”。建议新增：

```txt
Role Pack = 岗位任务模板 + 推荐连接器 + 推荐能力包 + 安全策略 + 示例任务
```

### 17.1 通用办公室包 `role-office-general`

内置：

```txt
- 今日简报
- 会议纪要
- 周报
- 文件夹总结
- 表格清洗
- PPT 初稿
- 邮件回复草稿
```

推荐连接器：本地文件、日历、邮箱、WPS/Office。

### 17.2 行政助理包 `role-admin-assistant`

```txt
- 会议安排
- 会议室确认
- 通知草稿
- 参会名单
- 制度问答
- 报销材料检查
- 文件归档
```

### 17.3 销售客户包 `role-sales-cs`

```txt
- 客户跟进看板
- 客户邮件草稿
- 方案 PPT
- 报价表草稿
- 竞品对比
- 合同到期提醒
```

### 17.4 项目运营包 `role-project-ops`

```txt
- 项目周报
- 风险矩阵
- 里程碑追踪
- 行动项追踪
- SOP 生成
- 跨部门同步材料
```

### 17.5 HR 招聘包 `role-hr-recruiting`

```txt
- 简历摘要
- 候选人对比
- 面试问题草稿
- 面试纪要
- 入职资料清单
- 培训反馈汇总
```

### 17.6 财务采购协同包 `role-finance-procurement-assist`

```txt
- 发票整理
- 报销清单
- 供应商报价对比
- 合同付款节点提醒
- 费用异常提示
```

安全说明：只做资料整理和异常提示，不做专业财税/审计结论，不做付款。

---

## 18. UI 优化：从“功能面板”变成“工作面板”

### 18.1 新导航

```txt
首页 / 今日
收件箱
项目
会议
文档
表格
PPT / 报告
周期任务
活产物
审批
连接器
记忆
设置
```

### 18.2 首页按钮文案

不要用：

```txt
执行 Agent / Run tool / MCP / 生成上下文
```

改用：

```txt
帮我准备会议
帮我写周报
帮我整理邮件
帮我清洗表格
帮我做 PPT
帮我跟进客户
帮我整理文件夹
```

### 18.3 执行动态展示

普通用户需要看到：

```txt
正在读取哪些来源
为什么需要这些来源
准备生成什么
哪里需要审批
结果在哪里
是否有风险
下一步建议是什么
```

建议执行时间线：

```txt
✅ 已确认任务范围：华东客户续约项目
✅ 已读取：3 份会议纪要、1 份报价表、2 封邮件摘要
⚠️ 发现：报价表包含金额字段，云模型外发需要审批
📝 已生成：续约方案大纲
⏸ 等待审批：将创建 续约方案初稿.docx
✅ 已写入本地产物
```

### 18.4 Context Stack 可视化

让用户知道 AI 为什么这样回答：

```txt
本次使用的上下文：
- 项目记忆：4 条
- 文件：3 个
- 邮件摘要：2 条
- 日历事件：1 个
- 用户本轮输入：1 条
- 未使用：财务文件夹，因为未授权
```

### 18.5 待审批中心

集中展示：

```txt
- 将写入文件
- 将覆盖文件
- 将移动文件
- 将创建草稿
- 将访问外部连接器
- 将把摘要发送给云模型
- 将刷新周期任务
```

---

## 19. Skills / Recipes / Hooks 的白领化补充

### 19.1 新增 Skills

```txt
skills/
  daily-briefing.md
  email-triage.md
  reply-draft.md
  meeting-brief.md
  meeting-minutes-to-actions.md
  weekly-report.md
  spreadsheet-cleaning.md
  spreadsheet-insight.md
  ppt-outline.md
  ppt-from-folder.md
  customer-followup.md
  competitor-tracker.md
  invoice-check.md
  resume-screening-summary.md
  project-risk-review.md
```

### 19.2 新增 Recipes

```txt
recipes/
  daily-work-briefing.json
  end-of-day-summary.json
  weekly-report-from-project.json
  prepare-meeting-brief.json
  meeting-minutes-to-followup.json
  inbox-triage-to-drafts.json
  folder-to-ppt.json
  spreadsheet-clean-and-chart.json
  customer-followup-dashboard.json
  competitor-live-artifact.json
  invoice-folder-to-reimbursement-sheet.json
  recruitment-candidate-comparison.json
```

### 19.3 新增 Hooks

```txt
hooks/
  block-auto-send-message.json
  block-auto-calendar-invite.json
  require-approval-before-cloud-context.json
  require-approval-before-overwrite-office-file.json
  require-approval-before-sharing-link.json
  require-source-citations-for-high-stakes-summary.json
  redact-sensitive-personal-info-before-model-call.json
  block-screen-automation-sensitive-apps.json
  require-draft-review-for-external-recipient.json
  pause-scheduled-task-on-scope-change.json
```

### 19.4 示例 Hook：禁止自动外发

```json
{
  "id": "block-auto-send-message",
  "event": "PreToolUse",
  "matcher": "EmailSend|MessageSend|CalendarInviteSend",
  "decision": "block_or_require_user_final_action",
  "reason": "Agent Cowork 2.2 不允许 AI 自动代表用户发送邮件、消息或会议邀请；请生成草稿并由用户手动确认。"
}
```

### 19.5 示例 Recipe：会议后跟进

```json
{
  "id": "meeting-minutes-to-followup",
  "name": "会议纪要转行动项和跟进草稿",
  "inputs": ["meeting_transcript_or_notes", "project_memory", "participant_list"],
  "steps": [
    { "skill": "meeting-minutes-to-actions", "mode": "read_only" },
    { "skill": "reply-draft", "mode": "draft_only" },
    { "tool": "Write", "target": ".AgentCowork/artifacts/会议行动项.md", "requiresApproval": true }
  ],
  "forbiddenActions": ["send_email", "send_message", "create_external_invite_without_review"],
  "outputs": ["actions_table", "followup_draft", "audit_log"]
}
```

---

## 20. 安全策略：普通白领版的“红线”

### 20.1 动作风险分级

| 风险 | 动作 | 默认策略 |
|---|---|---|
| 低 | 读取用户选择文件、生成本地草稿 | 允许或轻提示 |
| 中 | 写入新文件、创建副本、刷新看板 | 预览后审批 |
| 高 | 覆盖原文件、移动文件、访问外部连接器 | 明确审批 |
| 极高 | 发邮件/发群消息/邀请外部人/删除/提交表单 | 默认阻断或必须用户最终手动完成 |

### 20.2 敏感应用 Blocklist

屏幕自动化/RPA 模式默认禁止：

```txt
- 银行、证券、支付、税务、医保、医院、政府办事、电子签章、密码管理器
- 包含大量个人隐私、客户隐私、财务隐私的应用
- 用户手动加入 blocklist 的任何应用
```

### 20.3 草稿模式

所有对外动作都先进入：

```txt
Draft Mode
  - 邮件草稿
  - 群消息草稿
  - 日历邀请草稿
  - 表单填写草稿
  - 文档分享草稿
```

用户可以：

```txt
复制草稿 / 打开草稿 / 修改草稿 / 放弃草稿。
```

P0 不实现自动发送。

---

## 21. API 设计草案

```txt
GET    /api/workday/today
POST   /api/workday/briefing

GET    /api/inbox/items
POST   /api/inbox/capture
POST   /api/inbox/:id/plan
POST   /api/inbox/:id/archive

GET    /api/projects
POST   /api/projects
GET    /api/projects/:id
PATCH  /api/projects/:id
GET    /api/projects/:id/memory
GET    /api/projects/:id/artifacts
GET    /api/projects/:id/schedules

GET    /api/schedules
POST   /api/schedules
PATCH  /api/schedules/:id
POST   /api/schedules/:id/run-now
POST   /api/schedules/:id/pause

GET    /api/live-artifacts
POST   /api/live-artifacts
GET    /api/live-artifacts/:id
POST   /api/live-artifacts/:id/refresh
GET    /api/live-artifacts/:id/versions
POST   /api/live-artifacts/:id/restore

POST   /api/comms/email/triage
POST   /api/comms/email/draft-reply
POST   /api/comms/message/draft
POST   /api/calendar/meeting-brief
POST   /api/calendar/invite-draft

POST   /api/sheets/inspect
POST   /api/sheets/clean-preview
POST   /api/sheets/apply-clean-copy
POST   /api/ppt/from-folder-preview
POST   /api/ppt/create-draft
```

---

## 22. 数据库表草案

```sql
CREATE TABLE project_spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  local_root TEXT NOT NULL,
  privacy_mode TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_inbox_items (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  source_app TEXT,
  user_intent TEXT NOT NULL,
  captured_context_json TEXT NOT NULL,
  suggested_recipe TEXT,
  risk_level TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  allowed_sources_json TEXT NOT NULL,
  allowed_actions_json TEXT NOT NULL,
  approval_policy TEXT NOT NULL,
  output_target TEXT NOT NULL,
  last_run_at TEXT,
  next_run_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE live_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  data_sources_json TEXT NOT NULL,
  refresh_policy TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE live_artifact_versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  data_path TEXT NOT NULL,
  snapshot_path TEXT,
  source_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

---

## 23. 开发里程碑

### P0：白领首页 + Task Inbox + 项目空间

目标：用户打开后看到“今日工作”，能从任意文件夹/快捷入口创建任务。

任务：

```txt
- 新增 WorkdayHub UI
- 新增 TaskInbox 数据模型和 API
- 新增 ProjectSpace 数据模型和 UI
- 新增会议简报、周报、文件夹转 PPT 三个入口
- 新增草稿不发送 Hook
- 新增 Context Stack 展示
```

验收：

```txt
- 首屏不是空聊天框，而是今日工作驾驶舱。
- 用户可把本地文件夹创建为项目。
- 用户可把任务派入 Inbox，再生成计划。
- 写文件必须审批，外发只能生成草稿。
```

### P1：会议、邮件、表格、PPT 四大白领工作流

任务：

```txt
- Meeting Brief Recipe
- Meeting Minutes to Actions Recipe
- Email Triage / Reply Draft Skill
- Spreadsheet Inspect / Clean / Chart
- PPT From Folder Draft
- 周报生成 Recipe
- Artifact 版本和来源引用
```

验收：

```txt
- 能从会议文本生成行动项和跟进草稿。
- 能从邮件/消息摘要生成回复草稿。
- 能清洗表格副本并生成图表。
- 能从文件夹生成 PPT 初稿。
- 所有结果有来源、版本和审计。
```

### P2：周期任务 + Live Artifacts

任务：

```txt
- Scheduler
- 周期任务 UI
- Daily Briefing / End of Day / Weekly Report
- LiveArtifactEngine
- 客户跟进看板
- 项目风险看板
- 竞品追踪器
```

验收：

```txt
- 用户可创建每日/每周任务。
- 周期任务只读或草稿模式自动运行。
- Live Artifact 可手动刷新、定时刷新、查看历史版本。
```

### P3：中国办公连接器

任务：

```txt
- WPS / 金山文档 Connector
- 腾讯文档 Connector
- 飞书 Connector
- 钉钉 Connector
- 企业微信 webhook / bot 草稿 Connector
- 腾讯会议 Connector
- Outlook / IMAP Connector
```

验收：

```txt
- 每个 Connector 有 manifest、scope、权限说明、撤销入口。
- 默认只读摘要。
- 写入/外发必须单独授权和审批。
```

### P4：移动轻派活 + 屏幕自动化兜底

任务：

```txt
- 移动端任务提交入口
- 桌面端确认任务队列
- Browser Extension
- 受控 RPA / Screen Automation Preview
- App blocklist
- 操作截图/录屏审计
```

验收：

```txt
- 手机端可以把任务送到桌面，但桌面执行前要确认。
- 屏幕自动化默认关闭。
- 敏感应用默认阻断。
- 提交/发送/删除动作必须停下等待用户。
```

---

## 24. 测试计划

### 24.1 产品流程测试

```txt
- 新用户打开 Workday Hub
- 从文件夹创建项目
- 从 Inbox 创建任务
- 生成会议简报
- 生成周报
- 生成 PPT 初稿
- 清洗表格副本
- 创建周期任务
- 刷新 Live Artifact
```

### 24.2 安全测试

```txt
- 自动发送邮件应被阻断
- 自动群发消息应被阻断
- 覆盖原文件必须审批
- 周期任务改作用域必须重新审批
- 云模型外发本地摘要必须提示
- 屏幕自动化访问敏感应用必须阻断
- 邮件草稿必须展示收件人和外部域名
```

### 24.3 连接器测试

```txt
- scope 最小化
- token 不进前端
- token 不进日志
- 撤销后工具不可用
- 权限不足有清晰兜底
- 网络失败不阻塞本地功能
```

### 24.4 Live Artifact 测试

```txt
- 初次生成
- 手动刷新
- 定时刷新
- 数据源变更后刷新
- 历史版本恢复
- HTML iframe sandbox
- 无图表库时降级为表格
```

### 24.5 UI Smoke

新增脚本建议：

```txt
npm run smoke:workday-hub
npm run smoke:task-inbox
npm run smoke:project-space
npm run smoke:scheduled-tasks
npm run smoke:live-artifacts
npm run smoke:email-draft-safety
npm run smoke:meeting-workflow
npm run smoke:spreadsheet-workflow
npm run smoke:ppt-workflow
```

---

## 25. 商业化建议

### 25.1 个人版

```txt
- 本地文件
- 本地项目
- 基础记忆
- 手动任务
- 基础文档/表格/PPT
- 本地模型和自定义模型
```

### 25.2 专业版

```txt
- 周期任务
- Live Artifacts
- 高级表格处理
- 更多 Role Packs
- 邮件/日历连接器
- 浏览器插件
```

### 25.3 团队版

```txt
- 团队模板库
- 团队共享项目
- 组织级连接器
- 审计导出
- 角色权限
- 统一模型策略
```

### 25.4 企业版

```txt
- 私有部署/内网模型
- SSO / SCIM / RBAC
- SIEM / OpenTelemetry
- 数据留存策略
- 连接器 allowlist
- 自定义 Hook
- 离线能力包仓库
```

---

## 26. 最小可行版本：2 周 MVP 建议

如果只做一个短周期 MVP，建议只做 6 件事：

```txt
1. Workday Hub 首页。
2. Project Space：从本地文件夹创建项目。
3. Task Inbox：统一承接任务。
4. 三个白领 Recipe：会议简报、周报生成、文件夹转 PPT。
5. 草稿不发送 Hook + 写入审批。
6. Context Stack：显示用了哪些文件/记忆/连接器。
```

这 6 件事能让产品立刻从“技术 demo”变成“普通白领能懂的工作台”。

---

## 27. 参考资料

以下资料用于本方案的机制参考，具体产品实现应结合 Agent Cowork 的本地优先、安全审批和中文办公生态重新设计。

1. Claude Cowork 入门：Scheduled tasks、spreadsheets、presentations、projects。  
   https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork
2. Claude Cowork Projects：项目具有自己的文件、上下文、指令和记忆。  
   https://support.claude.com/en/articles/14116274-organize-your-tasks-with-projects-in-claude-cowork
3. Claude Cowork Scheduled Tasks：日报、周报、研究跟踪等周期任务。  
   https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork
4. Claude Cowork Live Artifacts：持久化、可刷新、可版本化的交互式 HTML 仪表盘。  
   https://support.claude.com/en/articles/14729249-use-live-artifacts-in-claude-cowork
5. Claude Cowork Computer Use 安全说明：权限、应用 blocklist、记忆可控、敏感应用限制。  
   https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork
6. Claude Cowork 安全使用建议：文件访问、周期任务、Act without asking、Computer Use 风险。  
   https://support.claude.com/en/articles/13364135-use-claude-cowork-safely
7. Claude Connectors：连接器访问应用和服务，并继承用户在源系统中的权限。  
   https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities
8. Claude for Outlook：Outlook、Word、Excel、PowerPoint 跨 Office 上下文；邮件和邀请应审阅后发送。  
   https://support.claude.com/en/articles/14855664-use-claude-for-outlook
9. Claude Custom Visuals：对话和 Cowork 中生成图表、流程图、交互式视觉。  
   https://support.claude.com/en/articles/13979539-custom-visuals-in-chat-and-cowork
10. Claude Skills：Skills 是按需激活的任务流程知识，Connector/MCP 负责工具和数据访问。  
    https://support.claude.com/en/articles/12512176-what-are-skills
11. 飞书开放平台：IM、云文档、云盘、电子表格、多维表格、日历、邮件、通讯录、任务、视频会议等能力。  
    https://open.feishu.cn/?lang=zh-CN
12. 钉钉开放平台 API 总览。  
    https://open.dingtalk.com/document/isvapp/api-overview
13. 金山文档开放平台：个人文档、应用文档、文档内容编撰、格式转换、预览、AirScript 等。  
    https://developer.kdocs.cn/server/guide/api.html
14. 腾讯文档开放平台：Open API、小程序、MCP、WebSDK。  
    https://docs.qq.com/open/document/
15. 腾讯会议开放平台：会议预定、会议管理、会议沉淀、云录制、投票、Webhook 等。  
    https://meeting.tencent.com/open-api.html

---

## 28. 最终建议

Agent Cowork 现在已经具备 Agentic loop、Plan Mode、MCP、安全边界、审批、审计、产物和记忆的底座。下一步最关键的是：

```txt
不要继续只堆“高级能力”，要把它包装成普通白领每天愿意使用的 6 个入口：

1. 今日工作
2. 收件箱
3. 项目
4. 会议
5. 表格/PPT/报告
6. 周期任务/活产物
```

真正的白领版 Agent Cowork 不应该让用户说“帮我调用某工具”，而应该让用户说：

```txt
帮我准备今天的会。
帮我写这周周报。
帮我把这个客户项目的材料整理成 PPT。
帮我看看哪些邮件需要我回复。
帮我把这个表格清洗一下，找出异常。
帮我每天早上生成项目风险看板。
```

然后系统做到：

```txt
先确认范围 → 先生成计划 → 先给预览 → 只生成草稿 → 等用户审批 → 本地留痕 → 可追溯可回滚。
```

这就是 Agent Cowork 从“本地 AI Agent”进入“真正办公 SaaS 产品”的关键一步。
