# Agent Cowork 对话流 UX 重构

> 日期: 2026-05-20
> 上游: `docs/agent-cowork-optimization-roadmap.md` 阶段 0
> 触发: 当前 UI 是 dashboard 范式 (主输入 + 8 个并列面板), 跟 Claude Cowork 的对话流范式根本不同。这份文档定义目标范式 + 迁移步骤。

---

## 1. 问题定位

当前 (从截图看):

```
┌────────┬─────────────────────────────────────────────┐
│ 会话    │  [任务卡片]  [任务模板]                       │
│ 列表    │  [可信工作区]  [操作预览]  [产物与审计]         │
│        │  [执行动态]                                   │
│        │                                              │
│        │  主输入 (顶部)                                 │
└────────┴─────────────────────────────────────────────┘
```

发送消息 → 8 个 panel 同时更新 / 闪烁 / 刷新 → 用户视线没有焦点, 也没有"我跟它在对话"的感觉。

Cowork:

```
┌────────┬─────────────────────────────────────────────┐
│ 会话    │  [对话 timeline, 滚动]                        │
│ 列表    │    • 用户气泡                                 │
│        │    • Kimi 气泡 (内嵌: 澄清卡/进度行/预览卡/审批) │
│        │    • 用户气泡                                 │
│        │    • Kimi 气泡 (内嵌: 文件卡片/来源/重新生成)    │
│        │  ────────────                                │
│        │  主输入 (永远在底部)                            │
└────────┴─────────────────────────────────────────────┘
```

发送消息 → 用户气泡追加 → Kimi 气泡流式展开 → 所有内容(澄清/进度/预览/审批/产物)都内嵌在那条 Kimi 气泡里 → 滚到底自动跟随。

**核心范式差异**: dashboard = 所有信息平铺并列; conversation = 所有信息按时间线串起来, assistant 气泡是富内容容器。

---

## 2. 目标布局

```
┌──────────┬───────────────────────────────────┬─────────┐
│ 左侧 280px │  中间 主对话流 (max-width: 760px 居中)  │ 右侧     │
│           │                                   │ 可折叠   │
│ 新建会话   │   [Derrick · 14:32]               │ 320px   │
│ 会话列表   │   把这个文件夹的会议纪要整理成 xlsx     │         │
│ 最近 6 条  │                                   │ 文件树   │
│           │   [Kimi · 14:32]                  │ /       │
│ ─────     │   看到 trusted root 下有 12 个     │ 任务列表 │
│           │   .docx, 在开始之前需要确认口径:     │ /       │
│ 已信任工作区│   ┌─────────────────────────┐    │ 模板    │
│           │   │ 选项 A / B / C            │   │ 库      │
│ Developer  │   └─────────────────────────┘    │         │
│ Mode 开关  │                                   │ (默认收起) │
│           │   ✓ 已读取 12 个 docx (4.2s)      │         │
│           │   ✓ 识别 47 条候选                 │         │
│           │   ⟳ 正在生成 xlsx 草稿…           │         │
│           │                                   │         │
│           │   ┌─ 操作预览 (等待审批) ────────┐  │         │
│           │   │ write artifacts/...xlsx    │  │         │
│           │   │ 47 行 × 5 列               │  │         │
│           │   └────────────────────────────┘  │         │
│           │   [审批执行] [查看 diff] [拒绝]    │         │
│           │                                   │         │
│           │   run a60e803d · 15.4s · 来源 12  │         │
│           │                                   │         │
│           │   ──────────────                  │         │
│           │   [📎  继续提问 · /模板 · @文件...] │         │
└──────────┴───────────────────────────────────┴─────────┘
```

不再有顶部"主输入 + 任务卡片 + 任务模板"三件并列。所有写动作都从对话流底部输入框发起。

---

## 3. 组件清单 (从 panel 改为 message-embedded)

| 当前 panel | 目标形态 | 触发时机 |
|---|---|---|
| 任务卡片 dock (顶部 6 条) | **不要顶部 dock**, 退到右侧可折叠"任务列表"; 主要任务状态显示为当前 assistant message 的头部 badge ("协作 · 进行中") | 始终隐藏, 用户主动展开右侧 |
| 任务模板 8 卡 | 主输入框 `/` 触发模板 picker (下拉 popover); 选中后插入模板 prompt 到输入框, 用户可改 | 用户按 `/` |
| 可信工作区文件列表 | 主输入框 `@` 触发文件 mention; 文件列表退到右侧可折叠面板, 默认不显示 | 用户按 `@` 或主动展开 |
| 操作预览 | **assistant message 内嵌 PreviewCard 组件**, 跟着对话气泡走 | Kimi 生成 plan 时 |
| 产物与审计 | assistant message 内嵌 ArtifactCard + 底部"来源 (12)"可点开 | apply 完成后 |
| 审批执行按钮 | assistant message 内嵌 ApprovalActions (3 按钮: 审批 / 查看 diff / 拒绝) | Preview 之后 |
| 执行动态 timeline | assistant message 内嵌 ProgressLines, 每行一个 step (`✓ 已读取... ✓ 已生成... ⟳ 正在...`) | 流式追加 |
| 用户指令显示 | 用户气泡本身 | 始终 |

---

## 4. 新组件库 (前端要建立的 React 组件)

每个组件都对应 Kimi CLI / Host API 返回的一段结构化数据。

### 4.1 `<MessageBubble role="user|assistant" runId="..." status="..." />`

- 头像 + 名字 + 时间戳
- assistant 气泡顶部可以有 status badge (`协作 · 进行中` / `协作 · 完成` / `对话` / `失败`)
- 子内容由 `<MessageBubble.Content>` 装,接受 chunks 数组

### 4.2 `<ClarificationCard question options multiSelect onAnswer />`

- 对应 Kimi CLI 返回 `{ "type": "clarify", ... }`
- 按钮组形式 (单选/多选), 选完调 `POST /api/runs/:id/answer`
- 选完按钮 disable, 下方追加用户的选择气泡 (跟正常用户气泡一样,但 status="answered")
- 这就是 AskUserQuestion 等价物

### 4.3 `<ProgressLine status icon text duration />`

- 单行: `✓ 已读取 12 个 docx (4.2s)` 或 `⟳ 正在生成 xlsx 草稿…`
- 状态: `pending` / `running` (spinner) / `done` / `failed`
- 多条 ProgressLine 叠在一起 = 当前 task 的执行轨迹
- 数据源: `runs/<id>.events[]`

### 4.4 `<PreviewCard ops summary risk />`

- 显示一组待执行 op (write / rename / move) + 文件路径 + 大小 / 行数 / diff 摘要
- 右上 badge: `等待审批` / `已审批` / `已拒绝` / `已回滚`
- 点击展开看完整 diff

### 4.5 `<ApprovalActions onApprove onViewDiff onReject />`

- 3 个按钮内嵌在 assistant 气泡里
- 主按钮"审批执行"是黑底白字, 视觉权重最高
- 审批后按钮组替换为"已审批 · 14:33 · [回滚]"

### 4.6 `<ArtifactCard file metadata onOpen onCopyPath onRegenerate />`

- 文件图标 + 文件名 + 大小 + "在系统中打开"按钮
- 点击在 Tauri/Electron 用 shell.openPath 打开
- 这是 present_files 等价物

### 4.7 `<SourcesFooter sources />`

- 折叠态: `来源 (12)`
- 展开态: 列每个引用 (相对路径 + 行号 / 段落), 点击在文件树定位
- 内嵌在 assistant 气泡底部

### 4.8 `<Composer onSend slashCommands mentions />`

- 永远固定在对话流底部 (不是固定屏幕底部, 跟随 main 滚动)
- 支持:
  - `/` → 弹模板 picker (上方 popover)
  - `@` → 弹文件 picker (上方 popover)
  - `#` → 弹历史 run picker
  - Shift+Enter 换行, Enter 发送
- 占位符: `继续提问 · /模板 · @文件 · #历史任务`
- 顶部可显示当前 in-progress run 的小标志, 提醒用户上一条还没完成

### 4.9 `<TaskStatusBadge runId status activeForm />`

- 跟在 assistant message 头部, 显示当前 run 状态
- `协作 · 计划中` (spinner) / `协作 · 等待审批` (橙色) / `协作 · 完成` (绿色) / `协作 · 失败` (红色)
- 不需要顶部 dock 也能看到状态

---

## 5. 后端协议变更 (从"刷新 panel"改为"事件追加")

### 5.1 当前 (推测)

`POST /api/kimi/plan` → 返回完整 `{ runId, preview, artifacts, ... }` → 前端各 panel 各自渲染。

### 5.2 目标: SSE / WebSocket 流式事件

`POST /api/runs` 创建 run → 返回 `runId` → 前端订阅 `GET /api/runs/:id/events` (SSE):

```jsonl
{ "type": "user_message", "text": "..." }
{ "type": "assistant_start", "runId": "...", "status": "planning" }
{ "type": "clarification", "question": "...", "options": [...] }
... 用户回答后 ...
{ "type": "progress", "icon": "check", "text": "已读取 12 个 docx", "duration_ms": 4200 }
{ "type": "progress", "icon": "loader", "text": "正在生成 xlsx 草稿…" }
{ "type": "preview", "ops": [...], "risk": "low" }
{ "type": "awaiting_approval" }
... 用户审批后 ...
{ "type": "applied", "artifacts": [{ "path": "...xlsx", "size": 14233 }] }
{ "type": "sources", "items": [...] }
{ "type": "assistant_end", "status": "done", "duration_ms": 15400 }
```

- 每个事件触发一个组件追加到当前 assistant 气泡
- 断线重连用 `Last-Event-ID` query 参数从中断点继续 (跟 scale-readiness 文档里 relay 协议一致)
- runs/*.json 仍然全量落盘, SSE 只是实时同步通道

### 5.3 兼容现有 `.AgentCowork/runs/*.json`

现有 runs/*.json 改为 event-sourced 结构:

```json
{
  "runId": "...",
  "tenantId": "local",
  "userId": "local",
  "createdAt": "...",
  "events": [
    { "ts": "...", "type": "user_message", ... },
    { "ts": "...", "type": "progress", ... },
    ...
  ]
}
```

历史会话打开时, 读 runs/<runId>.json 把 events[] 重放成对话气泡即可。这一改造同时跟 `docs/agent-cowork-scale-readiness.md` 第 3.6 节的 event-sourced orchestrator 对齐, 一举两得。

---

## 6. 迁移路径 (跟优化路线图 阶段 0 合并)

原来 `docs/agent-cowork-optimization-roadmap.md` 阶段 0 是"澄清气泡 + 任务卡片 + 进度行"。建议把它升级为"**整体改对话流**, 包含这三件":

### Week 1: 对话流骨架

1. 删除当前主输入顶部位置, 把它锁到主对话流底部, 加 sticky 定位。
2. 删除"任务卡片"顶部 dock。
3. 主区域改成滚动 timeline + 居中 760px 列。
4. 读 runs/*.json 把每条 run 渲染成 [用户气泡 + assistant 气泡] 一对。
5. 当前的"产物与审计 / 操作预览 / 执行动态" 3 个 panel 暂时仍可在右侧 collapsible drawer 看到, 不删, 留给老用户。

### Week 2: 事件流后端 + 内嵌组件

6. `apps/host` 增加 `GET /api/runs/:id/events` SSE 端点; 把当前 Kimi CLI 的 stdout 切成 events 推过去 (line-buffered, 每行 JSON)。
7. 前端建 4 个核心组件: `MessageBubble` / `ProgressLine` / `PreviewCard` / `ApprovalActions`。
8. assistant 气泡内嵌 PreviewCard + ApprovalActions, 跟随 SSE 事件追加。
9. 右侧老 panel 全部删除 (或合并进右侧 drawer 不默认展开)。

### Week 3: 澄清 + 模板 picker + 文件 mention

10. ClarificationCard 组件 + `/api/runs/:id/answer` 续跑。
11. Composer 加 `/` 模板 picker, 把 8 模板从顶部卡片移到这里。
12. Composer 加 `@` 文件 picker, 替代右侧文件列表的"必须始终可见"。
13. ArtifactCard 替换"产物"区, 在 assistant 气泡底部。
14. SourcesFooter 加在 assistant 气泡底部。

### Week 4: 流式 + 复跑 + 多任务

15. assistant 气泡支持"流式追加 chunks"而不是一次 swap; 进度行边来边渲染。
16. 同一会话支持多 run 并行: 用户在 Kimi 还没完成时再发一条, 起新 run, 老 run 继续在自己的气泡里走完。
17. 历史会话点击重新打开, 从 runs/*.json events 重放成对话流。

---

## 7. 关键设计决定 (容易做错)

1. **assistant 气泡是富内容容器, 不是"先文本后卡片"**: 内容顺序按事件时间, text/clarification/progress/preview/artifact 完全可以交错。一条 assistant 气泡里可以有 3 行文字 + 1 个 ClarificationCard + 等待 + 5 行 ProgressLine + 1 个 PreviewCard + 3 个 ApprovalActions + 1 个 ArtifactCard + 1 个 SourcesFooter。

2. **主输入框永远在对话流底部 sticky, 不要锁屏幕底部**: 锁屏幕底部在大屏不舒服; 锁对话流底部, 滚动条到底自动贴, 滚上去看历史时输入框跟着滚走 (像 ChatGPT/Claude.ai/Slack)。

3. **任务模板不在顶部 8 个卡片占位**: 改为 `/模板` 触发的 picker。8 卡片在第一次打开新会话时可以作为"空对话状态"的引导渲染在主对话流中间 (类似 ChatGPT 新对话的 example prompts), 一旦用户开始对话就消失。

4. **审批按钮内嵌, 不是固定面板**: 这是 Cowork 范式的关键。审批是对话流的一个节点, 不是常驻全局动作。审批完成后按钮组就变成"已审批 · 时间 · [回滚]"。

5. **不要在主对话流外重复显示"等待审批"**: 顶部 status bar / 右侧 panel 都不要再有"当前等待审批"提示, 焦点完全靠 assistant 气泡 + 自动滚到底定位。如果用户滚到历史不知道当前还有待审批, 用 Composer 上方的小条 ("有 1 个任务等待审批, 跳到底部 →") 提示。

6. **进度行流式渲染**: 不要等所有 step 完成才一次性出。Kimi CLI 在 stdout 每输出一行 JSON 进度, 前端就追加一个 `<ProgressLine>` 到当前气泡。

7. **空状态友好**: 新会话时主对话流不是空白 — 渲染一段简短欢迎 + 8 模板作为 prompt suggestion 网格 + Composer。点击模板 = 把模板 prompt 填到 Composer (不直接发送), 用户可以改。

8. **会话列表的语义跟"对话/协作/代码"三 tab 解耦**: 当前左侧"对话/协作/代码"三 tab 容易让用户以为是 3 个不同模式。建议改成"会话列表"统一显示所有 run, 每条会话用图标 / badge 区分类型 (一个对话气泡 / 一个协作图标 / 一个代码图标), 一个会话内不同类型的 turn 自然混合。

---

## 8. 一句话验收标准

**当用户能在主对话流里, 不离开主区域、不切 panel、不去顶部 dock, 完成"提问 → 看 Kimi 反问 → 选项卡片回答 → 看 Kimi 执行进度 → 在内嵌预览里点审批 → 看产物文件卡片 → 点开来源 → 继续追问"这一整条链路, 就是 Cowork 范式。**

只要这条链路里任何一步还需要用户去看屏幕别处的 panel, 就还是 dashboard。

---

## 9. 2026-05-20 实现状态

已落地到当前静态前端 MVP:

- `apps/windows-client/resources/index.html` 新增 `conversation-timeline`, 默认空状态提供 4 个 prompt suggestion。
- `apps/windows-client/resources/app.css` 新增 message bubble、assistant status badge、ProgressLine、PreviewCard、ApprovalActions、ArtifactCard、SourcesFooter 的静态样式。
- `apps/windows-client/resources/app.js` 新增对话流控制器: `appendAssistantMessage`, `addProgressLines`, `addPreviewCard`, `addApprovalActions`, `addArtifactCard`, `addSourcesFooter`。
- Composer 发送逻辑改为路由式: 普通问题走 `sendChatMessage`; 上传文件、本地文件、模板、代码和审批类任务自动 handoff 到 Cowork 计划流。
- Cowork 任务现在会在主对话流中追加: 用户气泡 -> Kimi 计划气泡 -> 进度行 -> 内嵌操作预览 -> 内嵌审批按钮 -> 执行完成产物卡。
- ClarificationCard 已有 MVP 版: 宽泛指令会在对话流和兼容 panel 中同时展示方向选择, 用户选择后继续生成计划。
- 修复了自动模板残留: 自动推断出的模板不会污染下一条消息; 只有用户手动选择或澄清选择才会持续生效。

当前仍保留的差距:

- 还不是 React 组件库, 当前是静态 HTML/CSS/JS 实现, 组件名对应 DOM helper。
- 后端还没有 `GET /api/runs/:id/events` SSE; 现在是一次请求后在前端追加伪流式进度。
- 历史 runs 尚未 event-sourced 重放成完整对话, 仍通过任务卡片和 run record 查看。
- `/` 模板 picker、`@` 文件 mention、`#` 历史 run picker 还未做成 Composer popover, 目前用空状态 suggestion、模板 panel 和上传按钮替代。
- 旧的任务卡片、操作预览、产物与审计、执行动态 panel 仍保留为兼容视图, 尚未合并成右侧 drawer。

本轮验收:

- `npm run smoke:ui` 通过。
- `npm run smoke:rendered-ui` 通过, 覆盖 1536x900 首屏、1366x768 compact、发送计划、审批执行、上传文件后从 Chat handoff 到 Cowork。
