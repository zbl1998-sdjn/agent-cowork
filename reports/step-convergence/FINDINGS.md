# 工具调用收敛 / 步数耗尽:真实 A/B 验证结论(2026-07-06)

针对"不要总是把步数耗尽"做的**真实模型** A/B。全部走真实 `runAgentChat` + 真实 Ollama
(`openai/local`,`temperature=0`),用一个包住 `defaultAgentModelCall` 的计数器精确统计
模型调用轮数与工具轮数;每个任务用独立临时工作区,`maxSteps=6`。

## 变量与对照
- **C(步数收尾提醒)**:`stepNudgeRatio=0`(关)vs 默认 `0.7`(开)。
- **B(工具使用纪律 system prompt)**:`toolDiscipline:false`(关)vs `true`(开),用 `resumeState`
  注入自定义 system prompt 隔离。

## 结果

| 场景 | 模型 | 变量 | baseline | treatment | 结论 |
| --- | --- | --- | --- | --- | --- |
| read-all(读 7 个文件后逐一总结) | qwen3:14b | C 开关 | toolRounds≈1–3,未耗尽 | 同上,nudge 未触发 | 无差异(模型并行批处理,早收敛) |
| read-all | qwen3:14b | B 开关 | toolRounds=1,未耗尽 | toolRounds=2,未耗尽 | 无差异(无纪律也已高效) |
| chain(10 段顺序链,链长>预算) | qwen3:14b | C 开关 | toolRounds=6 | toolRounds=6,**nudge 已触发** | 提醒确实注入,但模型仍跟着链读到预算 |
| chain | qwen2.5:3b | C 开关 | toolRounds=1 | toolRounds=3 | 弱模型**欠调用**(没跟完链就收尾) |

## 诚实结论

1. **无法用现有本地 Ollama 模型复现"步数耗尽"这一病态**:能力强的 `qwen3:14b` 会并行批处理、
   早收敛(读 7 个文件仅 1–3 轮),根本不会把 6 步预算用满;弱模型 `qwen2.5:3b` 反而**欠**调用
   (没跟完任务就停)。两者都没耗尽步数。因此在这些条件下,B/C **没有可测的步数下降**——
   不是 B/C 无效,而是**没有需要修的病**(天花板效应)。

2. **C(收尾提醒)可靠触发但是"软"信号**:chain/qwen3:14b 里 `step_budget_reminder` 事件确实
   在 ~70% 处发出(`nudgeFired=true`),但这个专注于任务的强模型没有因此提前收手,仍读到预算。
   即:提醒被可靠投递,但不会强行打断一个铁了心要完成任务的强模型。真正的硬边界仍是
   `stepBudget`/预算/超时护栏。

3. **B/C 无观测到的负面作用**:提醒只在过 70% 后触发一次(确定性单测已钉死),纪律是静态文本;
   本轮真实运行未见它们导致更多步数或异常。

## 边界(未验证/需更强 eval)

- 我怀疑用户观察到的"步数耗尽"更可能出现在:某个中档/会打转的模型、真正需要多步的
  agentic 多文件编辑任务,或改动前的旧提示词。这些条件本机 Ollama 复现不了。
- 要量化 B/C 在"会打转的模型"上的收益,需要一个会自然打转的模型 + 更大的任务集
  (可复用 `npm run eval` 的轨迹回放)。当前证据**不足以声称**平均步数下降。

## 已落地的可调开关(据此实验加入)

- `KCW_STEP_NUDGE_RATIO`(默认 0.7,0 关闭收尾提醒)
- `KCW_TOOL_DISCIPLINE`(默认开,`0/off` 关闭工具纪律块)
- `runAgentChat({ stepNudgeRatio, toolDiscipline })` / `buildSystemPrompt({ toolDiscipline })`

原始数据见同目录 JSON。
