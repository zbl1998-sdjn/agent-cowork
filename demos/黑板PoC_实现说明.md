# 共享黑板 PoC — 实现说明(完全真实 agent 驱动)

> 记录"多 agent 通过一块共享、受控、可审计的黑板协调"这个底牌是怎么实现的。
> 对应文件:`blackboard-poc-live.mjs`(完全真实驱动)/ 产出 `blackboard-live.md`(可打开看)。
> 另有 `blackboard-poc.mjs`(脚本驱动版,值写死,跑得快、用于快速演示)。

---

## 1. 目标

证明:**好几个真实 agent 能通过同一块共享记忆协调——A 写的 B 读得到、C 能纠正、D 能验证;而且写入受控、可溯源、可回滚。** 这是"黑板模式 / 共享治理记忆"这套设计的最小可见证据。

## 2. 核心原则:LLM 提议,确定性代码落盘

写入链路分三段,**LLM 只在第一段**:

```
真实 agent 产出文本  →  解析层(格式门)  →  确定性闸门落盘(盖来源章 + supersede)
   (LLM,会幻觉)         (代码,抽字段)        (代码,单写者,无 LLM)
```

- **agent 产出**:A/B/C/D 是真打到 Cowork host(3017)的真实 LLM 调用。
- **解析层 = 格式门**:`parsePort()` / `parseDb()` 从 agent 的真实输出里抽字段;**抽不出 = 拒写**(`gateWrite` 里 value 为 null 时记 `[REJECT]`)。这就是"严格格式"那道门的最小实现。
- **闸门落盘**:`gateWrite()` 是唯一写者,负责盖来源章(谁写的 + agent 真实原话)、做 supersede(值变了就把旧值标记失效并留痕)、再 `render()` 成可读的 `blackboard-live.md`。

## 3. 关键代码点

| 角色 | 代码 | 干啥 |
|---|---|---|
| 格式门 | `parsePort` / `parseDb` | 从真实输出抽 port / db;抽不出→拒写 |
| 写入闸门(单写者) | `gateWrite(agent, entity, value, quote)` | 盖来源章 + supersede + 落盘;无 LLM |
| supersede 治理 | `gateWrite` 里 `prev.value !== value` 分支 | 旧值标记失效,审计链留痕 |
| 可审计落盘 | `render()` | 把当前事实 + 审计链写成可打开的 md |
| 真实 agent | `ask(t, conv, prompt)` | 经 host 的真实流式 LLM 调用 |

每条事实的 provenance 里存了 **agent 的真实原话**(`quote`),所以黑板里每个值都能追溯到某个 agent 真说过的那句话。

## 4. 验证结果(真实跑,GREEN)

| Agent | 真实输出 | 闸门动作 |
|---|---|---|
| A(recorder) | `deploy_port=8080; database=PostgreSQL` | 写入 8080 + PostgreSQL |
| B(config) | `deploy_port=8080; database=PostgreSQL` | 读取(证明共享记忆生效) |
| C(corrector) | `deploy_port=9090` | SUPERSEDE 8080→9090,旧值留痕 |
| D(verifier) | `9090` | 读取确认 current=9090 |

`shareOK`(B 用到了 A 的事实)+ `govOK`(D 读到 supersede 后的值)双双通过。**黑板最终当前值 = 9090(Agent C),database = PostgreSQL(Agent A),审计链完整可回溯。**

## 5. 与脚本版的区别

- `blackboard-poc.mjs`:事实值**写死在脚本里**,闸门按剧本落盘。跑得快,适合快速演示文件格式。
- `blackboard-poc-live.mjs`(本版):事实值**全部从真实 agent 输出解析**。没有剧本成分,每个值都能追到 agent 原话。是更硬的底牌。

## 6. 诚实边界(面试别说漏)

- **已验**:多真实 agent 通过共享记忆协调、读后写、supersede 治理、来源溯源、可审计落盘、格式门(解析失败拒写)。
- **roadmap**:并发写(现在是顺序 A→B→C→D)、真值门(现在只有格式门,挡形状不挡假话)、写权限分级 / 提升门、单写者→乐观锁 CAS、Postgres、4000 步规模。

## 7. 如何运行

```powershell
# 先启动 Agent Cowork(host 监听 3017),然后:
cd "C:\Users\Administrator\Desktop\agent cowork\demos"
node blackboard-poc-live.mjs
# 跑完打开 blackboard-live.md 看当前事实 + 审计链
```

## 8. 面试一句话

> "我跑了个最小 PoC:四个真实 agent 通过一块共享黑板协调——A 写的事实 B 能读到、C 能纠正走 supersede、D 能验证,**黑板里每条值都追溯得到某个 agent 的真实原话**。写入走'LLM 提议→格式门解析→确定性闸门落盘'三段,落成一个可审计的文件。并发、真值门、规模化是 roadmap,但'共享 + 可治理 + 可溯源'这块,我有跑通的证据,不是空谈。"
