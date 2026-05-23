# Agent Cowork — 全面 Review 与 10 万用户并发可扩展性方案

> 基准目标：在不牺牲“本地桌面 Agent”定位的前提下，使架构具备演进到 **10 万并发用户** 服务端部署的能力。本文给出现状评估、已落地的并发加固、瓶颈清单、目标架构与分阶段路线图、以及测试策略。

## 0. 一句话结论

当前代码在“单进程、单工作区、按 tenant/user 打标”的数据面上**已经为多租户演进打了很好的地基**（幂等键、ULID、Ports & Adapters、审计 EventBus、SQLite 适配器、请求体限额、CORS/Origin 校验、取消注册表）。要支撑 10 万并发，核心工作是**把进程内有状态结构外置**、**让 host 无状态可水平扩展**、**把本地文件存储换成数据库 + 对象存储**，并补上**限流/背压、跨实例 SSE pub/sub、连接池、可观测性**。本会话已先行落地一批并发安全加固（见 §2）。

## 1. 现状评估（Review）

### 1.1 架构概览
- **形态**：Tauri 2 桌面壳 + Node host sidecar（零依赖 ES modules）。host 暴露 HTTP/SSE，UI 为 React 18 + Vite。
- **Agent 主链路**：`POST /api/agent/chat/stream` → `streamAgentChat` → `runAgentChat` 工具调用循环（Read/Write/Edit/Glob/Grep/Shell/WebFetch + mcp__ 连接器工具 + Skill/Agent/AskUserQuestion/ExitPlanMode/search_tools）。
- **数据面**：runs-index（JSONL/SQLite 适配器，ULID 主键，tenant 隔离）、memory（分层 + facts/notes，文件/SQLite）、schedules（cron）、审计（AuditEventBus + JSONL）。

### 1.2 已经做得好的（利于扩展）
- **幂等键**：关键写接口（file-ops/apply、recipes/:id/run、schedules）强制 `Idempotency-Key`，cache key 绑定 tenant/user/path/key + body 指纹，同 key 不同 body 返回 409。
- **请求边界**：`readJsonBody` 默认 1MB 上限且超限即 `destroy()`；`application/json` 强制；loopback Origin 校验。
- **租户打标**：所有请求注入 `traceId/tenantId/userId`，runs-index/scheduler/memory 均按 tenant 隔离 + version 乐观锁。
- **Ports & Adapters**：Repository/Store 抽象已存在（文件 ↔ SQLite 可切换），为换 Postgres/对象存储留出接口。
- **取消与审计**：`CancellationRegistry`（AbortController/runId）+ `AuditEventBus`（异步、不阻塞热路径）。

### 1.3 主要风险与不足（按严重度）
1. **进程内有状态**（阻断水平扩展）：approvals / cancellation / clarifications / RunEventBus / MCP clients 都是进程内 `Map`。多实例部署时跨实例不可见 → 必须外置或做 sticky-session 分片。
2. **本地文件存储**（阻断多实例）：runs/产物/artifacts 落本地磁盘，多实例间不可共享，且单机磁盘是瓶颈。
3. **SQLite 写并发**：`node:sqlite` 单文件适配器无法承载 10 万级并发写。
4. **无限流/并发上限**：单 host 可被无限并发 agent 流压垮（每条流 = 1 个 LLM 长连接 + 内存）。
5. **SSE 跨实例**：`/api/runs/:id/events` 重放依赖本进程的 RunEventBus；多实例下需 pub/sub（Redis/NATS）。
6. **鉴权缺失**：tenant/user 来自请求头默认值（`tenant_local`/`user_local`），尚无真实身份校验（多租户安全前提）。
7. **路径仍入业务记录**：runs/*.json 用路径字段而非 `blob_id` + CAS（文档既有项）。

## 2. 本会话已落地的并发安全加固

- **审批注册表有界化**（`runtime/approvals.js`）：每条 pending 带时间戳，超过 `ttlMs`（默认 15 分钟）自动 `prune` 并以 `reject` 解除等待；`maxPending`（默认 1 万）容量上限，超限丢弃最旧并 `reject`。→ 杜绝“被遗弃的 SSE 让 pending promise 永久泄漏 / agent 循环永久挂起”。
- **按 run 取消**：`approvals.cancelByRun(runId)` 精确解除某个 run 的全部待答请求（审批/计划/AskUserQuestion）。
- **客户端断连即清理**（`streamAgentChat`）：监听 `response`/`request` 的 `close`，断连时 `cancellation.cancel(runId)` + `approvals.cancelByRun(runId)`，由 `finished` 守卫避免正常结束误触发。→ 释放被遗弃的 LLM 调用与内存，这是 10 万并发下的关键止血点。
- **步间中断 + 用量统计**：`runAgentChat` 接 `AbortSignal` 每步检查中断；累计 token usage 于 `done`/`cancelled` 帧返回。
- **工具懒加载**：连接器工具按需经 `search_tools` 激活，避免 prompt 随连接器数量线性膨胀（降低每请求 token 与延迟）。

测试覆盖：`approvals-hardening`（TTL/容量/cancelByRun）、`disconnect`（断连 → pendingCount 归零）、`cancel-usage`（中断 + 用量）、`agent-stream-e2e`（全 HTTP 链路）。

## 3. 目标架构（支撑 10 万并发）

### 3.1 部署模型澄清
- **桌面模式（现状）**：每个用户本机一个 host，“10 万用户”= 10 万独立安装，天然水平扩展，重点是单进程健壮性（§2 已强化）。
- **服务端模式（演进目标）**：一组无状态 host 实例置于负载均衡之后，多租户共享。本节针对此模式。

### 3.2 无状态 host + 外置状态
- 将 approvals/cancellation/clarifications/会话级 sessionApproved 外置到 **Redis**（带 TTL），用 runId/approvalId 作键；审批回传与 SSE 推送通过 **Redis pub/sub** 跨实例路由。
- MCP 客户端连接：改为“连接器网关”服务或每租户连接池，避免在无状态 host 内长期持有子进程。

### 3.3 数据层
- runs-index/memory/schedules 适配器从 SQLite 切到 **Postgres**（已有 Repository 接口，新增 PG 适配器即可），按 `tenant_id` 分区/分片；ULID 主键已就绪。
- 产物/上传/artifacts 落 **对象存储（S3 兼容）**，业务表只存 `blob_id`（CAS：内容寻址 + 去重）。

### 3.4 流量治理
- **限流/配额**：按 tenant/user 的令牌桶（每分钟请求数、并发 agent 流数、月度 token 预算）。
- **并发上限 + 队列**：单实例 agent 流并发上限 + 排队，超出快速失败或排队，保护 LLM 后端。
- **熔断/重试/超时**：对 LLM 与 MCP 调用做熔断与指数退避（Gateway 侧已有部分能力）。

### 3.5 鉴权与多租户安全
- 接入真实身份（JWT/OIDC），从令牌解析 `tenant_id/user_id` 覆盖请求头默认值；所有数据访问强制按 tenant 过滤；path policy 维持工作区 jail。

### 3.6 可观测性
- 结构化日志（已含 trace_id）+ 指标（QPS、P50/P95/P99、活跃 SSE 数、LLM 延迟/错误率、队列深度、token 用量）+ 分布式追踪；健康/就绪探针。

## 4. 分阶段路线图

- **P0（已完成，本会话）**：进程内有界化 + 断连清理 + 取消/用量 + 懒加载。
- **P1 健壮性**：每租户限流与并发上限；agent 流排队；LLM/MCP 超时与熔断统一；body/上传大小分级限额；优雅停机（drain SSE）。
- **P2 无状态化**：approvals/cancellation/clarifications 外置 Redis + pub/sub；session 亲和或全外置；多实例 SSE 路由。
- **P3 数据层**：Postgres 适配器 + 对象存储 blob/CAS；按 tenant 分片；连接池。
- **P4 鉴权与配额**：OIDC/JWT、租户配额与计费、审计合规。
- **P5 规模验证**：负载/浸泡/混沌测试达标 10 万并发基准。

## 5. 测试策略（全面深入）

- **单元**：纯逻辑（注册表、幂等、路径策略、cron、usage 累计）——快、确定性。
- **集成（HTTP）**：路由 + SSE 帧契约（已有 e2e：file_written/verify/question/cancel/lazy）。
- **并发**：N 路并发 agent 流 + 随机断连，断言无泄漏（pending/事件总线/句柄回零）、无串租户。
- **负载/压测**：以 1 万 → 10 万阶梯并发 SSE 连接做 RPS/延迟/内存基准（k6/autocannon + 自定义 SSE 客户端）。
- **浸泡（soak）**：长时间稳定运行观察内存增长（验证 TTL/cap 生效，无句柄泄漏）。
- **混沌**：杀实例 / 断 Redis / LLM 超时，验证降级与恢复。
- **回归门禁**：`node --test` 全绿 + `tsc -b` 严格 + 关键 e2e 纳入 CI。

## 6. 立即可做的下一步（建议顺序）
1. 每租户限流 + 单实例 agent 流并发上限（P1，纯进程内即可见效，可测）。
2. 优雅停机：收到信号时停止接新流、drain 现有 SSE、`cancelAll`。
3. Redis 适配器原型（approvals/cancellation 外置）+ 多实例 SSE pub/sub（P2 关键路径）。
4. Postgres 适配器（runs-index 起步）+ 并发写压测。

## 7. 实施进度（本轮）

- **P0 进程内加固** ✅：审批注册表 TTL+容量+`cancelByRun`、客户端断连即清理、步间中断+用量、工具懒加载。
- **P1 优雅停机** ✅：`server.shutdown()`（draining→新流 503、`cancellation.cancelAll`、`approvals.cancelAll`、`closeMcp`、限时 `close`）+ main.js 接 SIGTERM/SIGINT。测试 `shutdown.test.js`。
- **P3 PostgreSQL 适配器** ✅（runs-index + memory + schedules 全部完成）：`storage/postgres-runs-index.js`、`postgres-memory-store.js`(facts/notes/system-block)、`postgres-schedule-store.js`(list/get/save/remove)；均异步、惰性可选 `pg`、可注入 pool、租户隔离；`migrations-postgres/0001_init.sql` 含 5 张对齐表；`KCW_STORE=postgres` + `DATABASE_URL` 启用；runs-index 读路由已 `await`。mock-pool 单测：`postgres-runs-index`(4) + `postgres-memory-schedule`(4) + HTTP `runs-index-async`(1)。
- **P4 鉴权（JWT/HS256）** ✅：`auth/jwt.js`（零依赖、验签/exp/nbf、claim 映射 tenant/user），Bearer 优先按 JWT 解析、回落不透明 session；`KCW_JWT_SECRET` 配置。测试 `jwt.test.js`。**租户配额**由每租户并发上限（`concurrency.js`，`KCW_MAX_RUNS_PER_TENANT`）兜底。
- **P5 抗泄漏/浸泡 + 实测基准** ✅（可跑部分）：`concurrency-soak.test.js`(40 路并发集体断开 → 注册表归零)；`scripts/bench-local.mjs` 单实例实测——150 并发 920 流/s p99≈147ms、500 并发 1064 流/s p99≈432ms,**0 错误且 approvals/runs/slots 全部归零(无泄漏)**;`scripts/load-sse.mjs` 多实例集群压测脚手架。**1万→10万** 需多实例 + 负载均衡(由 P2 跨实例机制支撑),按 500/实例 线性外推。
- **P2 状态外置 + 跨实例 SSE** ✅（机制 + server 接线已落地，差真库联调）：server 按 `KCW_STORE=postgres`+`DATABASE_URL` 选用 PG 审批/事件总线并启动 LISTEN,审批路由改 `await`(`postgres-wiring.test.js` 验证选用与 start);
  - **跨实例审批** `storage/postgres-approvals.js`：pending 入 `pending_approvals` 表，`request()` 仍同步(本地生成 id + INSERT fire-and-forget，几乎不动 agent 调用点)，resolve/respond/cancelByRun 经 `pg_notify` 跨实例投递；`postgres-approvals.test.js` 用「共享 mock pg 集群」验证 A 实例请求→B 实例解决/答题/cancelByRun 全部跨实例生效。
  - **跨实例 SSE pub/sub** `storage/postgres-event-bus.js`：保持 RunEventBus 的 publish/subscribe/replay 接口，`publish` 只发 `pg_notify`，LISTEN 收到后注入本地 bus(发布者自身 LISTEN 也收到→单次投递)；`postgres-event-bus.test.js` 验证 B 发布→A 订阅者收到、无重复投递、replay。
  - 迁移新增 `pending_approvals` 表。**剩余**：把这两个适配器经 `KCW_STORE=postgres` 接入 server(替换内存 approvals/RunEventBus)并在真实多实例 + Postgres 上联调。

## 8. 环境前置（启用 PostgreSQL 多实例）
1. `npm i pg`（在 `apps/host`，使可选依赖可解析）。
2. 用 `migrations-postgres/0001_init.sql` 初始化数据库。
3. 设 `KCW_STORE=postgres`、`DATABASE_URL=postgres://...`、`KCW_JWT_SECRET=...`、`PGPOOL_MAX=...`。
4. 多实例置于负载均衡之后；P2 落地后即可水平扩展。

## 9. 数据层全量 PostgreSQL

开启 `KCW_STORE=postgres` + `DATABASE_URL` 后, server 对全部持久化均选用 PG: runs-index、approvals(跨实例 LISTEN/NOTIFY)、run events(跨实例 pub/sub)、memory(`PostgresMemoryStore`, `/api/memory` 路由已 await)、schedules(`CachedPostgresScheduleStore` 同步门面 + 写穿透, 使同步 Scheduler 零改动获 PG 持久化)。`pg-fulllayer.test.js` + `postgres-wiring.test.js` 验证选用与异步路由。
