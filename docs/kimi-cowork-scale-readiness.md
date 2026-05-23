# Agent Cowork 规模就绪 (Scale Readiness) 架构准备

> 日期: 2026-05-20
> 上游: `docs/kimi-vs-claude-cowork-gap.md`, `docs/agent-cowork-optimization-roadmap.md`, `docs/mvp-1-windows-c-cloud-architecture.md`
> 目标: 当前阶段 Agent Cowork 仍是单机本地产品, 但所有不可逆的地基决策 (数据模型、接口、租户隔离、可观察性、消息边界) 必须现在做对, 让产品从 1 用户 → 100k DAU → 1M DAU 不重写, 1M+ 时只新增 region/分片不动业务代码。

---

## 0. 校准: "千万级 QPS" 到底意味着什么

| 量级 | 参考 |
|---|---|
| 100 QPS | 中小 SaaS 稳态 |
| 1k QPS | 一个中型 B2B SaaS 峰值 |
| 10k QPS | 头部国内 SaaS / 中型互联网产品峰值 |
| 100k QPS | Google 搜索峰值量级 |
| 1M QPS | Twitter 等头部社交峰值 |
| 10M QPS | 全球前 0.01%, 通常是 CDN / 边缘缓存 / 计数器层才到这量级 |

**结论**: 把"千万 QPS"作为业务请求口径不现实, 也不必要。

合理拆分:

- **业务请求 (用户主动操作)**: 目标稳态 10k-100k QPS, 峰值 1M (按 1000 万 DAU 算)。
- **审计/事件 (内部产生)**: 写入侧每条业务请求可放大 10-50 倍 (audit + tool calls + runs + metrics), 这部分可达千万 EPS, 但应该走异步消息总线 + 批量落库, 不进 hot path。
- **LLM 调用**: 单次延迟秒级, 走独立 worker pool + 队列, 跟 API QPS 解耦。

下面的设计都按这个分层来。

---

## 1. 总体原则: Ports & Adapters (六边形架构)

核心:

```
                业务用例 (Use Cases)
                       |
                  domain 层 (无依赖)
                       |
   ┌───────────────────┼───────────────────┐
   |                   |                   |
StoragePort       LLMPort             SandboxPort
   |                   |                   |
本地: SQLite      本地: Kimi CLI       本地: 子进程
云: Postgres+Redis 云: Kimi Gateway   云: Firecracker/K8s Job
                                          + Object Storage
   ...
```

**铁律**:

- 所有业务代码只依赖 Port 接口, 不直接 import SQLite/Postgres/S3。
- Adapter 切换 = 配置文件改一行, 不动业务代码。
- 单机模式 (本地客户端) 和云端模式跑同一份业务代码, 只换 adapter 实现。

这条做对了, 后面任何规模扩张都不需要重写; 这条做错了, 任何重写都救不了。

---

## 2. 组件清单: 做 / 接口 / 延后

### 现在就要做 (Phase A, 单机本地)

| 组件 | 做什么 | 为什么 |
|---|---|---|
| 业务领域模型 | 用 Go 在 `services/orchestrator/internal/domain/` 定义 `Workspace`, `Recipe`, `Run`, `Artifact`, `AuditEvent`, `Schedule`, `MemoryFact`, `Tenant`, `User` 实体, **所有实体强制带 `tenant_id` 字段, 哪怕只有 1 个租户** | 后期补 tenant_id 等于重写; 现在加几乎零成本 |
| 仓储接口 | `Repository[T]` 接口, `Save / Find / Query / Stream` 四个方法 | 业务代码只调接口 |
| 本地 SQLite adapter | 实现 Repository, 用 better-sqlite3 (Node) 或 mattn/go-sqlite3 (Go) | 单机够用, 写本地审计 |
| LLM Port | `LLMClient.Chat(ctx, req) (Resp, error)`, `LLMClient.Stream(ctx, req) (chan Chunk, error)`; req 必带 `tenant_id`, `trace_id`, `idempotency_key` | kimi-gateway 已经在做, 补流式 + tool calls 即可 |
| Sandbox Port | `Sandbox.Exec(spec) (Result, error)`, 本地用 Go 启子进程; 但 spec 是结构化 JSON, 不是 shell 字符串 | 后期换 Firecracker / Kubernetes Job 不动调用方 |
| 文件存储 Port | `BlobStore.Put / Get / Sign(presign url)`, 本地实现就是写到 trusted root; 云端换 S3/OSS/COS | 文件路径绝不能进业务代码 |
| 事件总线 Port | `EventBus.Publish(topic, event)`, `Subscribe(topic, handler)`, 本地用 channel + goroutine, 云端换 NATS/Kafka/Pulsar | audit 和 metrics 必须走异步, 不能 inline 进 hot path |
| 任务队列 Port | `JobQueue.Enqueue(job)`, `Worker.Process(handler)`, 本地用进程内 worker pool, 云端换 Temporal / Asynq / Sidekiq | LLM 调用必须走队列, 不能阻塞 HTTP handler |
| Idempotency | 所有写操作 (create_run, apply_ops, schedule_create) 必须收 `Idempotency-Key` header, 重复请求返回同一个 result | 网络重试天然存在; 没有这个云端会写脏数据 |
| Audit JSONL | 保留, 但只是 EventBus 的一个 subscriber | 跟业务解耦 |
| 上下文 trace_id | 每个 HTTP / IPC 请求生成 trace_id, 贯穿 Repository / LLM / Sandbox 调用 | OpenTelemetry 现在不接也行, 但 trace_id 必须现在就传 |

### 现在留接口, 延后实现 (Phase B, 多用户云端)

| 组件 | Phase A 状态 | Phase B 实现 |
|---|---|---|
| Auth | 本地单用户, 只有"系统用户", 但所有请求强制带 `user_id` (写死) + `tenant_id` (写死) 走中间件 | 接入 OAuth (企业微信 / 飞书 / Microsoft / Google) + JWT, 中间件验签 |
| Postgres adapter | 不写, 但 SQLite schema 必须能 1:1 迁到 Postgres (避免 SQLite-only 类型如 `INTEGER PRIMARY KEY AUTOINCREMENT`, 改用 ULID/UUIDv7 主键) | 实现 `pgx` adapter |
| Redis 缓存 | 不接, 但所有 read 接口允许调用方传 `cache_hint` | 接入 redis cluster, 缓存策略由配置驱动 |
| Object Storage adapter | 不写, 本地 BlobStore 就是 fs adapter | 实现 S3-compatible (Aliyun OSS / Tencent COS / MinIO) |
| 消息总线持久化 | 进程内 channel, 重启丢消息 (但写 EventBus 时已经把事件落了一份到 audit JSONL) | NATS JetStream / Kafka / Pulsar; audit JSONL 改为 sink |
| WebSocket Relay | services/relay 骨架已有, 不真接 | Phase B 上线: 客户端 ↔ 云端长连接, 推 plan 事件、审批状态、定时任务结果 |
| 限流 | 不做 | 每用户 + 每租户 + 全局三级令牌桶 (Redis) |
| 配额 / Billing | 不做, 但每次 LLM 调用都向 EventBus 发 `llm.usage` 事件并带 token 数 | 订阅 `llm.usage` 算费用 |
| 多区域 | N/A | 按 tenant_id hash 到 region, 客户端启动时拉路由表 |

### 完全延后, 不要现在动 (Phase C/D)

- 分库分表 (sharding) — 100k DAU 以下用不上
- CDN 节点 / 边缘计算 — 产品没流量先不动
- 自建 Kafka 集群 — 用云厂托管的就行
- 异地多活 — 1M DAU 之后再说
- 服务网格 (Istio/Linkerd) — 不到 50 微服务别上
- 自建 Prometheus + Loki — 用云厂可观测性平台撑过 10k QPS 再说
- 多模型路由 / Mixture of Experts gateway — 单 Kimi 先打好

---

## 3. 关键决策: 哪些选型能从 1k → 1M QPS 不重写

### 3.1 主键和 ID

- **现在就用 ULID 或 UUIDv7**, 不要用自增 INT。
- 理由: 分库分表后自增 ID 必撞; ULID/UUIDv7 全局唯一 + 单调递增 + 可排序, B+ 树友好。
- Go 库: `oklog/ulid/v2` 或 `gofrs/uuid` v7。
- 实施: 现在 `services/orchestrator/internal/domain/ids.go` 加 `NewID() ID` 工厂, 整个项目只通过工厂生成 ID。

### 3.2 数据库

- **本地 SQLite, 云端 Postgres**, 不要 MySQL (Postgres 的 JSONB / 部分索引 / RLS 在多租户场景胜过 MySQL)。
- Schema 设计铁律:
  - 所有表头三列必有: `id ULID PK`, `tenant_id ULID NOT NULL`, `created_at TIMESTAMPTZ`。
  - `tenant_id` 必有联合索引 `(tenant_id, created_at DESC)`, 这是后期分片的天然 shard key。
  - 不用 SQLite 特有类型, 用 `TEXT`/`BIGINT`/`BLOB` 这些 Postgres 也认的。
  - DDL 用 sqlc 或 golang-migrate, 不要手写 schema.sql。
- 后期 1M+ QPS: 按 tenant_id 范围 / 哈希分片到多 Postgres, Citus 或自切都行, 业务代码不变。

### 3.3 缓存

- **Phase A 不接 Redis**, 但留接口。
- Repository 的 Find 方法接受 optional cache adapter; 单机时 cache adapter 是 nil。
- Phase B 接 redis cluster, 缓存 invalidation 走 EventBus (每次 Save 发 `entity.updated`)。

### 3.4 文件 / 对象存储

- **铁律: 文件路径不进数据库**, 数据库只存 `blob_id`, 路径由 BlobStore.Resolve(blob_id) 返回。
- 本地实现: `~/.AgentCowork/blobs/<sha256-prefix>/<sha256>`, 内容寻址 (CAS)。
- 云端实现: S3-compatible, 同样按 sha256 作 key, 自带去重。
- 上传走 presigned URL, 不让文件流过业务服务。

### 3.5 LLM 调用

- **所有 LLM 调用走 kimi-gateway, 不允许业务代码直接 import HTTP client**。
- 调用必带:
  - `tenant_id`, `user_id`, `trace_id`, `idempotency_key`
  - `priority` (interactive / batch / scheduled)
  - `budget_token` (这次调用的 token 上限, 防失控)
- Gateway 内部:
  - 优先级队列 (interactive 走快通道, scheduled 走慢通道)
  - per-tenant 限流 (Redis token bucket)
  - 失败自动重试 (已实现) + 退避
  - 失败计数器 → 熔断 (circuit breaker, sony/gobreaker)
  - 每次调用产生 `llm.usage` 事件 (用于计费 + 监控)
- 流式: 加 SSE 端点 `POST /v1/chat/stream`, gateway 内部仍 fan-in fan-out。

### 3.6 任务编排 (services/orchestrator)

- 当前状态机已有, 但要确认状态转换是 **可幂等重放** 的。
- 每个 Run 写入"事件流" (`run.created`, `run.plan_generated`, `run.approval_requested`, `run.applied`, `run.completed`), 状态从事件流计算 (event sourcing lite)。
- 这样 Phase B 上 Temporal 或 Cadence 时, 现有状态机一对一映射。
- 不要在 orchestrator 里直接 commit 业务事务; 通过 EventBus 通知其他子系统。

### 3.7 设备中继 (services/relay)

- WebSocket session 必须 **无状态**: session 数据存 Redis (tenant_id + device_id), 不放进程内存。
- 否则 Phase C 扩到多实例时一切重写。
- 心跳 + 重连协议设计要现在定: ping 30s, 断连重连恢复 session 走 last_event_id (类似 SSE)。

### 3.8 可观察性

- **trace_id 现在就传**, OpenTelemetry SDK 不接也行但日志里必有 trace_id。
- 日志结构化 (zap/slog/logrus 都行, 但用 JSON output)。
- 每个 Port 自动产 metric: `port.<name>.duration_ms`, `port.<name>.errors_total`。
- Phase A 落到本地文件; Phase B 接 OTLP exporter → Aliyun SLS / Tencent CLS / 自托管。

### 3.9 客户端到云端协议

- 不要发明私有二进制协议, 直接 **HTTP/2 + JSON + protobuf 二选一**:
  - 控制面: HTTP/2 JSON (REST)
  - 高频小消息 / 流式: gRPC + protobuf
- 协议版本通过 URL 路径 `/v1/...`, 不要靠 header 协商。

### 3.10 单点不能容忍的部件

| 部件 | Phase A 状态 | Phase B 必须 |
|---|---|---|
| Postgres | 单实例 | 主从 + 自动 failover (云厂托管) |
| Redis | 不接 | 集群模式 |
| 消息总线 | 进程内 channel | NATS JetStream cluster |
| Object Storage | 本地 fs | 跨可用区 S3 |
| Auth | 单用户 | OAuth + JWT, 公钥可缓存 |
| kimi-gateway | 单进程 | 至少 3 副本, 上游 Moonshot 也要降级方案 |

---

## 4. 阶段路径

### Phase A (现在 - 3 个月): 单机本地, 接口准备就绪

- 完成 `docs/agent-cowork-optimization-roadmap.md` 阶段 0/1/2 全部内容。
- 同时:
  - 所有业务代码迁到 `services/orchestrator/internal/domain/`, 用 Ports & Adapters 重构。
  - SQLite schema 用迁移工具 (`golang-migrate` 或 `goose`) 管理。
  - 每个实体加 `tenant_id`, `user_id`, `trace_id`, `created_at`, `updated_at`, `version` (乐观锁)。
  - 业务幂等 + trace_id 走通端到端。
  - kimi-gateway 加流式 + 优先级队列 + 熔断。
  - 客户端 ↔ Host API 走 HTTP/2 JSON, 协议加版本路径。
- 不上云。

### Phase B (3-6 个月): 多用户云端 Beta, 10k DAU / 1k QPS

- 加 cloud profile, 部署 services/api + relay + orchestrator + kimi-gateway 到云 (Tencent / Aliyun / 自托管 K8s 都行)。
- Postgres 单主从 (RDS), Redis 单 cluster, S3-compatible 对象存储 (OSS/COS)。
- OAuth 接入 (企业微信 / 飞书 / Microsoft 三选一先做)。
- WebSocket relay 上线, 客户端走云端拉 plan 事件。
- 限流: per-user QPS + per-tenant token bucket。
- 监控: 接云厂可观测性平台 (Aliyun SLS / Tencent CLS)。
- 计费骨架: `llm.usage` 事件汇总, 不真扣费但出账单。

### Phase C (6-12 个月): 商业化 + 100k DAU / 10k QPS 峰值

- Postgres 读写分离 + 慢查询日志治理。
- Redis 分片 + 本地缓存 (singleflight + ristretto)。
- 任务编排迁 Temporal 或 Asynq, orchestrator 改为 workflow 写法 (业务代码几乎不变, 因为事件流早就是 event-sourced)。
- 消息总线接 NATS JetStream (替换进程内 channel)。
- 引入 CDN 给 Artifact HTML / 静态资源。
- 限流升级: 全局令牌桶 + 优先级降级 (LLM 调用先降级 batch, 保 interactive)。
- 灾备: Postgres 跨可用区 + 每天 PITR。

### Phase D (12 个月+): 1M+ DAU, 100k+ QPS 峰值, 接近"千万级"语义

- Postgres 按 tenant_id hash 分片 (Citus 或自切)。
- 多 region 部署, 客户端按 tenant_id 路由。
- kimi-gateway 加智能路由 (Moonshot 多账号、备用模型降级、本地小模型兜底)。
- 边缘缓存 Artifact 的只读视图。
- 此时再讨论 10M QPS, 才是个真问题。

---

## 5. 现在就该建立的 8 条不可逆"地基"

无论 Phase 走到哪里, 这 8 件事如果现在没做对, 后期返工成本指数级:

1. **所有实体加 tenant_id + user_id + trace_id + version**, 哪怕单用户也要写死塞值。
2. **ULID/UUIDv7 主键**, 不用自增 INT。
3. **Ports & Adapters 强制业务代码不 import 具体存储/LLM/sandbox**。
4. **Idempotency-Key 在所有写接口强制**, 客户端生成 UUID 并重试时复用。
5. **Schema 迁移用工具**, 不手写 ALTER TABLE。
6. **文件路径不进业务表**, 用 blob_id + CAS。
7. **Audit 走 EventBus 异步落盘**, 不 inline。
8. **trace_id 贯穿所有日志和 metric tag**, 现在就接 slog/zap 的 structured logging。

---

## 6. 反模式: 现在做了, 将来必须重写

| 反模式 | 为什么不能要 | 替代 |
|---|---|---|
| 业务代码 `import sqlite3` | 换 Postgres 时大面积改 | Ports & Adapters |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | 分库必撞 | ULID |
| 进程内 map 存 session | 多实例时丢 | Redis session |
| Sync inline 写 audit | hot path 拖慢, 失败影响业务 | EventBus 异步 |
| 文件路径写入业务表 | 迁对象存储时一锅端 | blob_id + CAS |
| LLM 调用 sync HTTP | 高峰打爆 worker, 没有限流 | Gateway + Queue |
| HTTP API 没有 trace_id | 出问题查不到 | 中间件强制注入 |
| 单租户写死 → 后期补 | "后期补" = 全表 migration + 业务回归测试地狱 | Day 1 就有 tenant_id |
| WebSocket session 进程内 | 横向扩缩容时断连 | Redis 共享 session |
| Schema 手写 ALTER | 部署不可重放, 灰度不可滚回 | Migration tool |

---

## 7. 跟现有 services/* 骨架的对齐

当前 services 目录已有 4 个骨架, 大体方向是对的, 但需要落实以下改造:

### services/api

- 加中间件: `request_id`, `tenant_id` 注入, `idempotency`, `rate_limit`, `auth` (Phase A 是 no-op + 写死 user)
- API 路径 `/v1/...`, 协议 OpenAPI 3, 用 oapi-codegen 生成 server/client
- handler 只调 use case, use case 只调 Port

### services/relay

- WebSocket session 一开始就走 Redis (Phase A 可用 miniredis 单元测试, 但接口已定型)
- 协议设计: `{ "type": "...", "event_id": "ulid", "tenant_id": "...", "payload": {...} }`
- 重连用 `last_event_id` query 参数 (类似 SSE), 服务端从 Redis 回放未送达事件

### services/orchestrator

- 当前状态机改成 event-sourced: 写 events → 计算 state
- Repository 写 events table, 不直接写 state
- 状态机的转换函数纯逻辑, 不依赖 IO; 跑 Temporal 时直接复用

### services/kimi-gateway

- 已经有 OpenAI-compatible 非流式 chat + 重试 + 超时, 加:
  - SSE 流式
  - Tool calling (OpenAI tools schema)
  - Vision (multipart with image_url)
  - 优先级队列 + per-tenant 令牌桶 (内存版即可, Phase B 换 Redis)
  - 熔断器 (gobreaker)
  - 每次调用发 `llm.usage` 事件到 EventBus
  - 多账号轮询 (key pool) + 失败降级到备用 baseURL

### apps/local-agent (Go)

- 是 SandboxPort + BlobStore 的本地实现
- CLI 已具备, 加 gRPC server 模式 (`agent serve --addr unix:///tmp/agent.sock`), 让 Host (Node) 通过 IPC 调用而不是 spawn CLI
- 后期客户端 ↔ 云端模式, Local Agent 退化为本地缓存 + 文件同步 agent

### apps/host (Node)

- 当前是 PoC, Phase A 末期建议 Go 重写或退役
- 临时方案: Node host 调 Go local-agent 走 unix socket, 业务逻辑全转到 Go (services/orchestrator)
- Node 仅承担前端静态文件 + websocket 网关

---

## 8. 一句话总结

**做 6 件事, 跳过 100 件事**: 加 tenant_id / 加 ULID / 加 trace_id / 加 idempotency / 加 Ports & Adapters / 加 EventBus 异步 audit。除此之外的所有"为高并发准备"现在都不要动 — Redis 不接、Kafka 不接、分片不分、多区域不开、服务网格不上。把上面 6 件做好, Phase B/C/D 任何时候都不需要重写业务代码, 只需要换 adapter + 加副本。

千万 QPS 不是"现在就用千万级配置", 是"现在的代码三年后还能跑"。

---

## 9. 2026-05-20 本轮地基落地状态

已落地到当前仓库:

- **Host 请求上下文**: `apps/host/src/server.js` 为请求生成并返回 `x-trace-id`、`x-tenant-id`、`x-user-id`, 默认单机值为 `tenant_local` / `user_local`。
- **Host 幂等写入**: `/api/file-ops/apply` 支持 `Idempotency-Key`, 同一 tenant/user/path/key 的重复请求会返回缓存结果, 不会重复写入。
- **Cloud API 中间件雏形**: `services/api/internal/http/routes.go` 注入 trace/tenant/user context, `/v1/*` POST 强制要求 `Idempotency-Key`。
- **Orchestrator domain 地基**: `services/orchestrator/internal/domain/` 新增无依赖 ULID 形态 ID 工厂、带 `TenantID/UserID/TraceID/Version` 的 `BaseEntity`, 以及 `Repository`、`LLMClient`、`SandboxPort`、`BlobStore`、`EventBus`、`JobQueue` Port 接口。
- **验证覆盖**: Node 测试覆盖 Host context、Recipe、文档抽取、幂等写入; Go 包通过 `go test -c` 编译级验证。

本轮未做, 仍按 Phase B/C 保留:

- SQLite/Postgres adapter、schema migration、EventBus 持久化、JobQueue worker pool。
- Redis session、NATS/Kafka、Object Storage、OAuth、限流、计费。
- kimi-gateway 流式、tool calls、vision、熔断和多账号路由。
- services/relay Redis session 和 `last_event_id` 回放协议。
