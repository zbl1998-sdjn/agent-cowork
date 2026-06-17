# 共享黑板 (Blackboard) — MASE 多 Agent PoC

> 多个 agent 通过这一块**共享、受控、可审计**的记忆协调。
> 所有写入经过确定性闸门:**盖来源章(谁写的)+ supersede 治理(改了留痕)**。
> LLM 只负责"提议要写啥",落盘是代码。

## 当前事实 (current facts)

| 实体 | 值 | 来源 agent | 时间 (UTC) | 状态 |
|---|---|---|---|---|
| deploy_port | 9090 | Agent C | 2026-06-14 10:00:43 | current |
| database | PostgreSQL | Agent A | 2026-06-14 10:00:30 | current |

## 审计链 (audit log — 谁写了什么,可回溯 / 可回滚)

- [2026-06-14 10:00:30] Agent A 写入 deploy_port=8080 | source: turn#1
- [2026-06-14 10:00:30] Agent A 写入 database=PostgreSQL | source: turn#1
- [2026-06-14 10:00:36] Agent B 读取 → 基于 deploy_port + database 生成启动配置(只读,未写黑板)
- [2026-06-14 10:00:43] Agent C SUPERSEDE deploy_port: 8080 → 9090 | reason: correction | 旧值(Agent A 写的)标记失效
- [2026-06-14 10:00:49] Agent D 读取 → 确认 current deploy_port = 9090 ✓

---
_minimal visible blackboard primitive:顺序写入 + supersede 治理已验。并发写 / 真值门 / 4000 步 = roadmap。_
