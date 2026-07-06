# 共享黑板 (Blackboard) — 完全由真实 agent 驱动

> 每条事实都从**真实 agent 的输出**里解析得到(不是脚本写死)。
> 写入路径:真实 agent 产出 → 解析(格式门)→ 确定性闸门落盘(盖来源章 + supersede)。

## 当前事实 (current facts)

| 实体 | 值 | 来源 agent | 时间 (UTC) | 状态 |
|---|---|---|---|---|
| deploy_port | 9090 | Agent C | 2026-06-14 10:05:31 | current |
| database | PostgreSQL | Agent A | 2026-06-14 10:04:33 | current |

## 审计链 (每条都带 agent 的真实原话,可回溯)

- [2026-06-14 10:04:33] Agent A 写入 deploy_port=8080 | 来源原话:"deploy_port=8080; database=PostgreSQL"
- [2026-06-14 10:04:33] Agent A 写入 database=PostgreSQL | 来源原话:"deploy_port=8080; database=PostgreSQL"
- [2026-06-14 10:05:12] Agent B 读取共享黑板 → 真实输出:"deploy_port=8080; database=PostgreSQL"
- [2026-06-14 10:05:31] Agent C SUPERSEDE deploy_port: 8080 → 9090 | 来源原话:"deploy_port=9090" | 旧值(Agent A)标记失效
- [2026-06-14 10:05:45] Agent D 读取共享黑板 → 真实输出:"9090"

---
_完全 agent 驱动:值全部来自真实 LLM 输出。并发写 / 真值门 / 4000 步 = roadmap。_
