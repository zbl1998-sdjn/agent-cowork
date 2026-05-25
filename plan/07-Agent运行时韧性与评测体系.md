# 07 · Agent 运行时韧性与评测体系 — 实施计划(强标准)

> 目标:把"能跑的 agent"补成"**敢当生产系统长时间放手跑**的 agent"。专补运行时基础设施缺口:**评测、上下文管理、循环韧性、可恢复/可复现、可观测/归因**。
>
> 约束:遵守 `00` 分层与依赖方向 / `01` 工程标准与 DoD / **P0-T0 铁律(碰已有模块前先写特征测试)** / `04` 质量门禁。**规矩#0:动手前先确认本计划涉及模块的依赖关系(见 §0),依赖不清不写代码。**
>
> 强标准基线:全部做成**小模块 + 可插拔接口**,**严禁塞进上帝类**(尤其 `kimi/agent/tool-loop.js`、`kimi/agent-runner.js`、`runtime/run-store.js`);接入这些热点文件前必须先补特征测试,接入后"断言不改仍全绿"。

---

## §0 模块归属与依赖关系(对齐 `00` 的 L0→L4 + 可插拔接口)

> 依赖方向铁律:只能向**更低层**依赖。新增模块大多落在 L1(能力层)与 L2(运行时);**评测(eval)是离线工具,只读地调用 agent,绝不被运行时反向依赖**。

| 能力 | 层 | 新增 / 改动模块 | 接口(插件化) | 依赖方向 |
| --- | --- | --- | --- | --- |
| Token 估算 | host L1 | `kimi/context/token-estimator.js` | `TokenEstimator{ count(text|messages) }` | 仅依赖 L0;被 context/loop 依赖 |
| 历史压缩 | host L1 | `kimi/context/history-compactor.js` | `HistoryCompactor{ fit(messages, budget) -> messages }` | 依赖 token-estimator + model-call(摘要) |
| 工具结果摘要 | host L1 | `kimi/context/tool-result-summarizer.js` | `ToolResultSummarizer{ shrink(result, budget) }` | 依赖 token-estimator |
| 循环护栏 | host L1 | `kimi/agent/loop-guard.js` | `LoopGuard{ observe(call,ok); shouldBreak() }` | 纯函数,无外依赖 |
| 工具重试 | host L1 | `kimi/agent/tool-retry.js` | `RetryPolicy{ run(fn) -> result }` | 纯函数 |
| 断点/续跑 | host L2 | `runtime/run-checkpoint.js` `runtime/run-resume.js` | `Checkpointer{ save(runId,state); load(runId) }` | 依赖 storage(L1)/run-store |
| 录制/回放 | host L2 | `runtime/model-recorder.js` | `ModelRecorder` / `ModelReplayer`(model-call 装饰器) | 装饰 `kimi/model-call`,不改其签名 |
| 运行指标 | host L2 | `runtime/run-metrics.js` | `RunMetrics{ record(runId, metric) }` | 依赖 run-events(L2) |
| 版本归因 | host L2 | `runtime/run-store` 增字段 + `kimi/system-prompt` 版本戳 | — | 先补 run-store 特征测试 |
| **评测体系** | **eval(离线)+ scripts** | `eval/{tasks,scorers,runner,report}.js` + `scripts/eval.mjs` | `EvalTask` `Scorer` `EvalRunner` | **只读调用 host;不被任何运行时模块依赖** |
| 预算/熔断 | host L2 | `runtime/budget-guard.js` | `BudgetGuard{ check(usage,elapsed) -> ok|abort }` | 依赖 run-metrics(L2) |
| 整轮超时 | host L1 | tool-loop 注入 wall-clock | 复用 `AbortController`/signal | — |
| 回路注入防护 | host L1 | `kimi/safety/untrusted-content.js` | `InjectionGuard{ wrap(toolOutput) }` | 纯函数 |
| 工具参数校验 | host L1 | `kimi/agent/arg-validator.js` | `ArgValidator{ validate(name,args,schema) }` | 纯函数 |
| 决策 trace | host L2 | `runtime/run-trace.js` | `RunTrace{ append(event) }` | 依赖 run-events(L2) |

> 接入热点文件清单(必须先有特征测试):`kimi/agent/tool-loop.js`、`kimi/agent-runner.js`、`runtime/run-store.js`、`kimi/model-call.js`。

---

## A · 评测体系(Eval)— 最高优先,守住质量的地基

> 设计:**离线、可复现、可进 CI、多维打分**。eval 在隔离工作区里跑代表性任务,采集运行指标并打分;与运行时解耦(只读调用)。默认走录制/回放模型后端(见 D3),不烧真 token、结果确定。

| ID | 任务 | 主要文件 | 前置 / 测试 | 验收(强标准) | 估 |
| --- | --- | --- | --- | --- | --- |
| A1 | `EvalTask` schema + 代表性任务集(覆盖:文件读写、工作区检索、多步重构、审批流、Office 产物、批量文件、对话分支) | `eval/tasks/*` | 新模块单测 | **≥ 20 个 golden 任务**,可加载、可扩展、带预期断言 | M |
| A2 | `Scorer` 接口 + 多维打分:成功/失败、工具调用次数与效率、步数、延迟、token 与成本 | `eval/scorers/*` | 单测 | 每任务产出结构化分数 JSON | M |
| A3 | `EvalRunner`:逐任务在隔离 trusted root 跑、收集 run 指标、聚合 | `eval/runner.js` | 单测(mock model) | 一次跑完任务集出汇总 | M |
| A4 | 评测报告产物:pass-rate / 基线回归对比 / 趋势(HTML + JSON) | `eval/report.js` `scripts/eval.mjs` | — | **一条命令 `npm run eval` 出报告 + 基线对比** | M |
| A5 | 离线复现后端(复用 D3 录制/回放),eval 默认不联网不烧 token | 复用 `runtime/model-recorder.js` | 单测 | eval 默认离线、确定性可复现 | S |
| A6 | 接入 CI:prompt/模型/agent 循环变更触发回归 eval,**低于基线阈值即失败** | `scripts/ci.mjs` | — | 改 system-prompt 即跑 eval;pass-rate 跌破"基线−5%"则 CI 红 | S |
| A7 | **安全 / 红队任务集**:间接提示注入、诱导危险命令、越权读写、绕过审批等,断言护栏不退化 | `eval/tasks/redteam/*` | 单测 | 红队任务 100% 被正确拦截 / 拒绝;退化即 CI 红 | M |

**量化目标**:建立 pass-rate 基线;回归不得低于基线 −5%;**红队任务拦截率 100%**;eval 全程离线可复现;`npm run eval` 接入 `npm run ci`。

---

## B · 上下文管理 — 决定能否扛长任务

> 现状缺口:消息只追加、单条工具结果硬截断 8000 字、无 token 账、无历史压缩。设计:可插拔 token 估算(启发式默认,可换精确实现);超预算时摘要最旧轮 + 保留近 N 轮与关键事实;超长工具结果先摘要再回灌。

| ID | 任务 | 主要文件 | 前置 / 测试 | 验收(强标准) | 估 |
| --- | --- | --- | --- | --- | --- |
| B1 | `TokenEstimator` 接口 + 启发式实现(可后续换 tiktoken) | `kimi/context/token-estimator.js` | 单测 | 估算 text/messages token,误差可接受 | S |
| B2 | `HistoryCompactor`:超预算时摘要最旧轮、保留近 N 轮 + 关键事实清单 | `kimi/context/history-compactor.js` | 单测(行为锁定) | **≥ 200 轮 / 超预算不溢出窗口,且关键事实不丢(特征测试断言)** | M |
| B3 | 工具结果摘要(替代硬截断):大结果先摘要再回灌,保留要点 + 来源 | `kimi/context/tool-result-summarizer.js` | 单测 | 大工具结果可读、不撑窗、要点不丢 | M |
| B4 | 接入 `tool-loop`(消费 ContextManager) | `kimi/agent/tool-loop.js` | **前置:补 tool-loop/agent-runner 特征测试** | 接入后断言不改仍全绿;长任务稳定 | M |

B1 完成记录(2026-05-25):新增 `kimi/context/token-estimator.js` 启发式 `TokenEstimator`,支持 text/messages token 估算、message overhead、reply primer、tool call / object content 计数与 `heuristic-v1` 元数据;已纳入 host `checkJs` 类型护栏。`npm run test:host` 通过(499 tests,498 pass,1 skip)。

B2 完成记录(2026-05-25):新增 `kimi/context/history-compactor.js` 纯 `HistoryCompactor`,超预算时生成确定性压缩 system message、保留最近消息、提取 `FACT/IMPORTANT/DECISION/关键事实/偏好` 等关键事实清单,并在 retained 内容过大时按预算裁剪而不溢出窗口;≥200 轮历史、关键事实保留和极紧预算边界均有单测锁定。已纳入 host `checkJs` 类型护栏。

B3 完成记录(2026-05-25):新增 `kimi/context/tool-result-summarizer.js` 纯 `ToolResultSummarizer`,用 token 预算替代 `JSON.stringify(result).slice(0,8000)` 式硬截断前置能力;小结果保持可读原样,大结构化/文本结果压缩成含关键要点、来源与预览的摘要,并优先保留与关键要点绑定的 source。大结果不撑窗、要点不丢与 source-like 行保留均有单测锁定。已纳入 host `checkJs` 类型护栏。

---

## C · 任务循环韧性 — 敢长时间放手跑的前提

| ID | 任务 | 主要文件 | 前置 / 测试 | 验收(强标准) | 估 |
| --- | --- | --- | --- | --- | --- |
| C1 | `LoopGuard`:检测重复 / 连续失败的同类工具调用,达阈值打断并给可读提示 | `kimi/agent/loop-guard.js` | 单测 | **同一(工具+参数指纹)重复 ≤ N 次即打断**,不空转烧步数 | M |
| C2 | 工具级重试 + 指数退避:仅对**可重试错误**(网络/文件锁/超时);明确不可重试的(权限/参数错)不重试 | `kimi/agent/tool-retry.js` | 单测 | 瞬时失败自动重试 ≤ M 次;永久失败立即上报不重试 | M |
| C3 | 接入 `tool-loop`(LoopGuard + RetryPolicy) | `kimi/agent/tool-loop.js` | 前置特征测试 | 接入后行为不变;红/死循环用例被正确处理 | S |

---

## D · 可恢复与可复现 — 长任务与调试的基础设施

| ID | 任务 | 主要文件 | 前置 / 测试 | 验收(强标准) | 估 |
| --- | --- | --- | --- | --- | --- |
| D1 | `Checkpointer`:每步持久化循环状态(messages / step / usage / 已审批集 / todo) | `runtime/run-checkpoint.js` | 单测 | 任意步后状态可完整读回 | M |
| D2 | `run-resume`:从最近检查点续跑;**幂等**——跳过已完成工具、校验副作用,不重复写文件 | `runtime/run-resume.js` + tool-loop 接入 | **前置 tool-loop 特征测试** | 崩溃 / 重启后长任务可从断点续跑,无重复副作用 | L |
| D3 | `ModelRecorder`/`Replayer`(model-call 装饰器):录制真实响应、按输入回放复现 | `runtime/model-recorder.js` | 单测 | 同输入确定性回放;eval/调试可复现 | M |
| D4 | 种子化:随机 / ULID 注入种子(复用 L0 `util/ids`),运行可复现 | `kimi/agent/*` 注入点 | 单测 | 给定种子,运行轨迹可复现 | S |

---

## E · 可观测与归因 — 让结果可解释、可追溯

| ID | 任务 | 主要文件 | 前置 / 测试 | 验收(强标准) | 估 |
| --- | --- | --- | --- | --- | --- |
| E1 | `RunMetrics`:逐运行记录 token / 成本 / 延迟 / 步数 / 工具次数 / 失败率 | `runtime/run-metrics.js` | 单测 | **每运行 100% 有结构化指标** | M |
| E2 | 前端成本 / 可观测面板(接 P3-C):用量、费用、工具"为什么"、来源跳转 | `components/*` + `lib/api` | 组件纯逻辑测 | 用户可见每次运行的用量 / 成本 / 原因 | M |
| E3 | 版本归因:run 记录绑定 system-prompt 版本 + 模型 + 关键配置快照 | `runtime/run-store` 增字段 + `kimi/system-prompt` 版本戳 | **前置 run-store 特征测试** | **每个结果可追溯到 prompt / 模型 / 配置版本** | S |
| E4 | 决策 trace:结构化记录"模型看到什么→决定调哪个工具→为什么→结果",可回放调试 | `runtime/run-trace.js` | 单测 | 任一运行可回放其决策轨迹用于排错 | M |

---

## F · 预算、超时与熔断 — 防止失控烧钱 / 卡死(上版缺失,补)

> 现状缺口:只有 `maxSteps` 兜底,没有成本/时间硬上限,也没有整轮超时。生产级 agent 必须能"自己刹车"。

| ID | 任务 | 主要文件 | 前置 / 测试 | 验收(强标准) | 估 |
| --- | --- | --- | --- | --- | --- |
| F1 | `BudgetGuard`:per-run & per-session 的 **token / 成本 / wall-clock 硬上限**,超限自动 abort(kill-switch),给清晰收尾 | `runtime/budget-guard.js` + tool-loop 接入 | **前置 tool-loop 特征测试** | 超预算立即安全停止、不烧爆;收尾文案可读 | M |
| F2 | 整轮 wall-clock 超时(独立于 maxSteps 与单工具超时) | tool-loop 注入 `AbortController`/signal | 单测 | 长跑超时被干净中断,状态可收尾 | S |
| F3 | 流式中断恢复:模型流中途断开时,已累计的 content/tool_calls 不丢、可重试该步 | `kimi/model-call.js` + model-resilience | **前置 model-call 特征测试** | 流断不致整轮失败,可恢复或安全降级 | M |

## G · Agent 回路安全(防注入 / 工具输出不可信)— 保护"agent 的脑子"(上版缺失,补)

> 现状缺口:路径 jail 保护了文件系统,但**没保护 agent 的推理不被恶意内容劫持**。网页/文件/工具输出里的恶意指令(间接提示注入)可能改写 agent 行为。

| ID | 任务 | 主要文件 | 前置 / 测试 | 验收(强标准) | 估 |
| --- | --- | --- | --- | --- | --- |
| G1 | `InjectionGuard`:工具/网页/文件输出回灌前**标注为"数据、非指令"**,中和可疑的指令注入模式 | `kimi/safety/untrusted-content.js` + tool-loop 接入 | **前置 tool-loop 特征测试 + 注入用例** | 注入式工具输出无法改写 agent 行为(红队任务验证) | M |
| G2 | 工具参数 schema 校验:执行前用工具声明的 `parameters` 校验模型给的 args,非法即拒并回灌错误(不进 handler) | `kimi/agent/arg-validator.js` + tool-loop 接入 | 单测 | 畸形/越界/缺字段参数被拦在 handler 之前 | M |
| G3 | (交叉 A7)红队 eval 覆盖注入/越权/危险命令,作为回归护栏 | 复用 `eval/tasks/redteam/*` | — | 回路安全护栏退化即 CI 红 | S |

---

## 排期建议(强标准下的推进顺序)

1. **第一梯队(守质量的地基)**:`D3 录制/回放` → `A 评测体系(A1–A4 + A7 红队)` → `A5/A6 接 CI`。先把"能客观衡量 agent 好坏 + 护栏不退化"立起来——之后所有 prompt/模型/循环改动都有回归护栏。
2. **第二梯队(扛长任务 + 安全刹车)**:`B 上下文管理`(B1→B2→B3→B4) + `C 循环韧性`(C1/C2→C3) + **`F 预算/超时/熔断`** + **`G 回路安全`**。这一梯队做完才敢"长时间放手跑"。
3. **第三梯队(放手跑 + 可解释)**:`D1/D2 断点续跑` + `E 可观测与归因`(含 E4 决策 trace)。
- 全程**一特性一提交 + DoD**;接入 `tool-loop/agent-runner/run-store/model-call` 任一前,**先补该模块特征测试**(P0-T0);每条满足 `04` 门禁。

## 完成标准(DoD · 较强)

- eval:≥ 20 golden 任务、`npm run eval` 出报告、进 CI、回归阈值"基线−5%"硬卡。
- 上下文:长对话(≥ 200 轮/超预算)不溢出、关键事实不丢(特征测试锁定)。
- 韧性:重复工具调用 ≤ N 次即打断;可重试错误自动退避重试 ≤ M 次,永久失败不空转。
- 可恢复:任意步崩溃可从检查点续跑,工具副作用不重复。
- 可复现:给定种子/录制,运行可确定性回放。
- 可观测:每运行 100% 记录指标;每结果可追 prompt/模型/配置版本;任一运行可回放决策 trace。
- 预算/熔断:per-run & per-session 的 token/成本/wall-clock 硬上限生效,超限自动安全停止;整轮超时可中断。
- 回路安全:工具/网页/文件输出按"不可信数据"处理,注入式内容无法改写 agent 行为;工具参数执行前过 schema 校验;红队 eval 拦截率 100%。

## 风险与开放问题

- **Token 估算精度**:启发式 vs 精确(tiktoken 引入依赖)——先启发式,接口可换;eval 用录制后端可旁路成本。
- **压缩丢信息**:摘要旧轮有丢关键事实的风险——必须有特征测试锁"关键事实保留";摘要调用模型有成本,设触发阈值。
- **eval 判分**:部分任务"成功"需语义判定——优先确定性断言;LLM-as-judge 作可选项(带成本与不稳定性,需固定 judge 版本)。
- **续跑幂等**:工具副作用(已写文件、已发请求)重放风险——续跑必须跳过已完成步并校验,写操作要可识别"已执行"。
- **注入防护的边界**:`InjectionGuard` 是纵深防御之一,不能保证 100% 中和所有注入——务必配合"工具输出当数据、最小权限、审批 + 红队 eval"多层兜底,不可只靠它。
- **预算熔断的误杀**:硬上限设太低会误杀正常长任务,太高失去意义——需按真实任务标定阈值,并让用户可配。
- **续跑幂等的副作用**:已写文件/已发请求的重放风险,见 D2;续跑必须能识别"已执行步"。
- **交叉依赖**:与 `P3 多模型`(eval 要支持按 provider 跑)、`05-A1d 嵌入 RAG`、`P3-C 成本面板`有交叉,落地时对齐接口,不重复造。

> 导航:本文件已纳入 `plan/README.md` 文档目录和 v1.0 总范围。
