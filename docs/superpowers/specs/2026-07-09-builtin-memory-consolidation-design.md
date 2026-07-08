# 自带记忆 · 短期缓冲 → 提炼 → 主题知识（关闭 MASE 也可用）

- 日期：2026-07-09
- 状态：已批准（brainstorming），待 writing-plans 出实现计划
- 分支：`feat/builtin-memory-consolidation`

## 1. 背景与问题

2026-07-09 记忆测试（关闭 MASE、只用 agent cowork 自带记忆）暴露两个真实问题：

- **问题 A（同会话失忆）**：`/api/agent/chat/stream` 从服务端看是单轮的——聊天 schema 无
  `messages/history` 字段、`runAgentChat`/`tool-loop` 不按 `conversationId` 加载历史、UI
  `lib/api/chat.ts` 也只发 `{prompt, conversationId}`。**多轮对话记忆 100% 由 MASE 提供**；
  MASE 关闭后 Turn 2 完全不记得 Turn 1。
- **问题 B（长上下文丢记忆）**：`history-compactor.ts` 超预算时会截断 system 消息且留头弃尾，
  而注入的记忆块在系统提示末尾，是第一个被丢的（小窗口本地模型 / 超大 MEMORY.md 会触发）。

现状：五层记忆（`memory-layers.ts`：enterprise/user/project/local/session，仿 Claude Code
CLAUDE.md 层级）只做只读注入；`session` 层此前靠 MASE 喂；结构化 items 存储
（`memory-control.ts` 的 upsert/list/delete + `buildMemorySnapshot` 的 used/omitted 相关性
挑选）只能显式 API/UI 写入，没有"对话→记忆"的自动沉淀。

## 2. 目标 / 非目标

**目标**
- 关闭 MASE 时，agent cowork 用自带五层记忆实现跨会话记忆：能把对话总结成主题知识，新对话里
  想起之前说过什么。
- 顺带修好问题 A（同会话连续性）。
- 核心约束"不污染"：选择性提取、置信度门、去重合并、容量上限+淘汰、DLP 不存密钥、来源溯源、
  可关闭、面板可见可控。

**非目标（本设计不做）**
- 不移除 MASE；内置系统不依赖 MASE，二者可并存。
- 不做向量检索/嵌入（相关性沿用现有关键词 snapshot 口径；接口预留可后续替换）。
- 问题 B 的压缩器保护，作为独立小修在 Phase 1 附带（见 §7），不属于本记忆子系统主线。

## 3. 已定设计决策（brainstorming）

| # | 决策 | 选择 |
| --- | --- | --- |
| 记什么 | 主题知识条目（跨对话聚合/去重/合并的结构化知识库） | C（最强） |
| 何时提炼 | 每个对话结束时提炼一次（LLM，用聊天同款 modelCall） | 对话结束触发 |
| 怎么召回 | 相关性挑 top-K active 注入 + 提供 `SearchMemory` 记忆检索工具 | 混合 |
| 入库把关 | 高置信直接 active，低置信进 pending 待确认队列 | 置信度门 |

## 4. 核心洞察

问题 A 与"主题知识"同源——都因 host 不存对话轮次。引入**按对话的短期轮次缓冲**同解两者：
下一轮把缓冲当"最近对话"喂 session 层 → 同会话连续性；对话结束把缓冲交 LLM 提炼成主题知识
→ 跨会话长期记忆。即人脑记忆路径：**短期缓冲 → consolidation → 长期知识**。

## 5. 架构（host · L1 memory，遵守 plan/00 分层与文件体积软上限 250 行）

| 组件 | 层 | 职责 |
| --- | --- | --- |
| `conversation-buffer.ts` | L1 memory | 每轮成功后 append `{role,text,ts}`（先 DLP 脱敏）到 `<root>/.AgentCowork/memory/conversations/<convId>.jsonl`；按轮数/字节滚动；读最近 N 轮 |
| `consolidate.ts` | L1 memory | 对话结束触发：载缓冲 → 注入 modelCall 提取 → DLP → 去重合并 → 置信度门 → 容量淘汰 → 写 items → 归档缓冲 |
| `knowledge-extractor.ts` | L1 memory | 纯函数：构造保守提取 prompt + 解析/校验模型返回的 `{topic,title,content,confidence}[]`（无模型或解析失败则空数组，不阻断） |
| items 存储扩展 | L1 memory-control | 现有 item 增 `confidence/status(active\|pending)/topic/provenance{sourceConvId,ts}`；dedup/merge/supersede；per-scope 容量上限+淘汰 |
| `SearchMemory` 工具 | L1 tools/agent-tools | 只读、jail 到 trustedRoot：按 query 返回相关 active 知识条目 |
| 读写接线 | L3 routes/agent-stream | 写缝 append 缓冲；读缝注入 session 缓冲 + 相关性 top-K active items + 原五层 MEMORY.md |
| 触发 | L2/L3 | 惰性（切到新 convId 先 consolidate 上一个）+ 空闲计时 + 显式 `/api/memory/consolidate` + 后台兜底清扫 |
| 面板 | UI | 记忆面板显示 active/pending，approve/edit/delete，"consolidate now" |

## 6. 数据流

**写（每轮成功后，agent-stream 写缝）**：`appendConversationTurn(root, convId, {role,text})`，DLP
脱敏后落 jsonl；按轮数上限（默认 40）/字节上限（默认 32KB）滚动。

**读（每轮开始，agent-stream 读缝，受 `enabled/paused/incognito` 总闸约束）**：
1. session 层 = 当前 convId 缓冲最近若干轮（脱敏）→ 同会话连续性。
2. 跨会话 = 按当前 prompt 相关性挑 top-K active 知识条目（复用 `buildMemorySnapshot` used/omitted）。
3. 原五层 MEMORY.md 静态事实。
三者合并有总字节上限；相关性未命中的条目靠 `SearchMemory` 工具按需查。

**提炼（对话结束）**：`consolidateConversation(root, convId, modelCall)`：
1. 载缓冲；空/过短则跳过。
2. `knowledge-extractor` 注入保守 prompt（只要耐用主题知识；跳过闲聊/一次性任务/纯问答；不含密钥；
   每条给 confidence 0–1）→ 解析校验。
3. 逐条 DLP → 按 `topic` 归一去重/合并 existing（同 topic 改值 supersede，不新增重复）。
4. 置信度门：`confidence ≥ 阈值(默认 0.7)` → status=active；否则 → status=pending。
5. 容量：active 超 per-scope 上限（默认 200 条 / 总字节上限）→ 淘汰最久未相关项，`log` 淘汰内容
   （不静默截断）。
6. 记 provenance（sourceConvId, ts, confidence）；归档/裁剪缓冲（留小尾巴续连续性，原始缓冲可删）。

## 7. 防污染（全部默认内建）

- 保守提取 prompt + 每条 confidence；置信度门（高 active / 低 pending）。
- 去重合并/supersede（同 topic 不重复；stale 被最新覆盖并留痕）。
- 容量上限 + 淘汰（不静默截断，淘汰有 log）。
- DLP：复用现有 `redactText`/`carriesSecret`——缓冲写入与 item 入库都脱敏，绝不存密钥。
- 来源溯源：每条知识记 sourceConvId + ts + confidence，可在面板回溯"这条来自哪次对话"。
- 总闸：复用 `enabled/paused/incognito`——暂停/隐身则不缓冲、不提炼、不注入。
- 用户可控：面板可见 active/pending，可 approve/edit/delete，可手动 consolidate。

**附带小修（问题 B）**：`history-compactor` 压缩时保护注入的记忆块——system 消息不做尾截断
（或把记忆置于受保护段），只折叠历史。作为 Phase 1 的独立小提交。

## 8. 五层落位 / 与 MASE 关系

- `session` 层 = 对话缓冲（以前靠 MASE，现自带）。
- 主题知识条目 = 扩展现有 items 存储，按 `scope` 归 user/project；经相关性 snapshot 注入。
- 五层 MEMORY.md 仍是人工确认的耐用事实层。
- 内置系统**始终自带、不依赖 MASE**；MASE 若在则并存无害，同会话续接以本地缓冲为准（确定性、本地）。

## 9. 分期交付（小步多次，各自门禁绿 + 一特性一提交）

- **Phase 1**：`conversation-buffer` + agent-stream 读写接线 → 同会话连续性（**单独修好问题 A**）；
  附带问题 B 压缩器记忆保护小修。回归：把上一轮"Turn2 记得 Turn1(MASE off)"测试转成必过。
- **Phase 2**：`knowledge-extractor` + `consolidate` + items 存储扩展（置信度门/去重合并/容量/DLP/
  溯源）+ 触发（惰性 + 显式端点）。
- **Phase 3**：混合召回（相关性 top-K 注入 + `SearchMemory` 工具）+ pending 待确认队列端点 + 面板 UI +
  空闲/后台触发兜底。

## 10. 测试策略

- **单测**：缓冲 append/滚动/边界；extractor 解析/校验/降级；consolidate（注入假 modelCall 返回罐装
  条目）；去重合并/supersede；置信度门 active vs pending；容量淘汰有 log；DLP 脱敏；相关性挑选；
  压缩器记忆保护。
- **集成（host）**：MASE-off 全流程——同会话 Turn2 召回 Turn1；对话结束 consolidate 出条目；新对话
  相关性召回；`SearchMemory` 命中；pending 批准生效。
- **真实模型 smoke（gated）**：一条 kimi 端到端验提取质量，证据存 `reports/`。

## 11. 验收标准（每期）

- Phase 1：MASE-off 下同会话多轮记得前文；`npm run check` + `test:host`/`test:ui` 全绿。
- Phase 2：一段对话结束后生成 active 主题知识条目、低置信进 pending、同 topic 不产生重复、密钥不入库、
  每条可溯源；门禁全绿。
- Phase 3：新对话按相关性召回过往主题知识、`SearchMemory` 可补查、面板可管 active/pending；门禁全绿 +
  真实模型 smoke 证据。
