# Agent Cowork 合并执行基线

> 生成时间：2026-05-20  
> 适用目录：`C:\Users\Administrator\Desktop\agent cowork`  
> 当前结论：原 Node/Electron/Kimi CLI 计划只能作为 MVP-0 本地 PoC；正式 MVP-1 必须转向 Windows C 前端 + 本地 Agent + 可扩展多用户云端后端 + 长期千万级 QPS 架构。

## 1. 结论

当前目录里的两个计划不能直接混成一个单一 MVP。

- `plan/2026-05-20-agent-cowork-implementation-plan.md`
  - 保留为 **MVP-0：Kimi CLI 本地原型计划**。
  - 用途：快速验证 Kimi-only、trusted workspace、本地文件树、上下文 bundle、diff/apply、审批、审计、Kimi Web 安全启动。
  - 限制：Node.js/TypeScript + React/Vite + Electron 不符合正式 C 前端方向；本地单机 host API 不符合多用户后端和千万级 QPS 目标。

- `plan/kimi_workspace_cowork_mvp_plan.md`
  - 升级为 **MVP-1 正式架构的主要方向来源**。
  - 应保留：Windows 主流用户、C/Win32 + WebView2、Local Agent、云端 API、Device Relay、Task Orchestrator、Kimi Gateway、文件操作 Journal、回滚、多用户扩展、QPS scaling。
  - 应收敛：云端/SaaS/QPS 是正式主线，但 MVP-1 第一阶段仍要可落地，不能一次性实现所有企业级能力。

执行口径：

```text
MVP-0 = 本地 PoC，可保留、可测试、可作为能力验证。
MVP-1 = 正式产品架构，必须按 C 前端 + Local Agent + Cloud Backend 设计。
后续实现不得再把 Node/Electron 版本当成正式 MVP 主线。
```

## 2. MVP-0 定位

MVP-0 是开发验证层，不是最终产品主线。

MVP-0 可以继续验证：

- Kimi-only 调用链。
- 本地 trusted workspace。
- 文件树、文件读取、上下文 bundle。
- 文件操作 preview/apply。
- 审批和 audit JSONL。
- `kimi --version`、`kimi info`、`kimi web` 的本机集成。

MVP-0 不承担：

- 面向普通 Windows 用户的正式客户端。
- 多用户账户体系。
- 云端任务编排。
- 设备中继。
- 生产级 Kimi Gateway。
- 千万级 QPS 目标。

## 3. MVP-1 正式产品定位

MVP-1 的一句话定义：

```text
Agent Cowork for Windows 是一个 Kimi-only 的本地文件夹级 Cowork 产品：
Windows C 客户端负责用户体验和本地授权，
Local Agent 负责本机文件工具、路径安全、Journal 和回滚，
Cloud Backend 负责多用户、多设备、任务编排、审批流和 Kimi Gateway。
```

核心用户流程：

```text
安装 Windows 客户端
-> 登录账户
-> 注册设备
-> 选择本地 workspace
-> 输入目标或选择任务模板
-> Kimi 生成计划
-> 用户确认计划
-> Local Agent 扫描/读取授权文件
-> 云端 Orchestrator 调度 Kimi 和工具
-> 展示报告、引用、diff/文件操作预览
-> 用户审批
-> Local Agent 执行文件操作并写 Journal
-> 必要时回滚
```

## 4. 正式技术栈

### Windows Client

```text
apps/windows-client/
  src/
    main.c
    app_window.c
    tray.c
    webview_bridge.cpp
    native_bridge.c
    auth.c
    workspace.c
    ipc.c
    net.c
    json.c
  resources/
    index.html
    app.css
    app.js
```

原则：

- 主程序 C-first。
- WebView2 只做 UI 渲染，不承载核心权限逻辑。
- C++ 只作为极薄 WebView2 COM shim。
- 客户端只连接 localhost Agent 和云端 API/Relay。

### Local Agent

```text
apps/local-agent/
  cmd/agent-cowork-agent/
  internal/workspace/
  internal/tools/
  internal/journal/
  internal/relay/
  internal/policy/
```

推荐 Go 实现，原因：

- Windows 文件、路径、服务、网络和并发支持成熟。
- 单文件部署简单。
- 比 C 更适合快速实现本地工具、WebSocket、JSON、Journal。

Local Agent 职责：

- workspace 授权和路径白名单。
- 文件树、文本提取、hash。
- 文件操作 preview。
- 用户审批后执行 write/rename/move。
- Journal 和回滚。
- 与 Device Relay 建立 WSS 长连接。
- 不读取授权目录外文件。

### Cloud Backend

```text
services/api/
services/relay/
services/orchestrator/
services/kimi-gateway/
services/workers/
packages/proto/
infra/docker-compose.yml
infra/k8s/
docs/qps-scaling.md
```

服务边界：

- API Service：用户、设备、workspace、任务、审批、产物元数据。
- Device Relay：维护客户端长连接，把云端工具调用下发到在线设备。
- Task Orchestrator：任务状态机、工具调度、审批等待、失败恢复。
- Kimi Gateway：Kimi API 封装、模型选择、限流、预算、重试、prompt 模板。
- Workers：PDF/DOCX/XLSX/PPTX 解析、报告/表格生成、异步产物处理。

数据层：

- PostgreSQL：用户、租户、设备、任务、审批、workspace 元数据。
- Redis：短期状态、限流、会话缓存、幂等锁。
- NATS JetStream 或 Kafka：任务事件、工具调用、状态流。
- S3/MinIO：产物、快照、日志包。
- ClickHouse：后续审计分析和用量分析。

## 5. Kimi-only 边界

所有模型和 agent 能力必须来自 Kimi/Moonshot：

- Kimi API。
- Kimi Code 能力。
- 开发期可复用本机 `kimi.exe`。
- 生产期通过 Kimi Gateway 统一封装，不能要求普通用户预装 Kimi CLI。

禁止：

- 把 Claude 私有二进制、VM bundle、session schema、插件、日志或配置复制进产品。
- 把用户整个本地文件夹无差别上传云端。
- 客户端暴露 Kimi API Key。

## 6. QPS Scaling 目标

千万级 QPS 不能理解成所有请求都打到模型。必须拆分：

```text
控制面 QPS：登录、设备、任务、审批、元数据 API
事件面 QPS：设备心跳、任务状态、工具调用事件
文件面 QPS：上传/下载产物、短期签名 URL、对象存储访问
模型面 QPS：Kimi Gateway 到 Kimi API 的真实模型请求
```

长期扩展策略：

- Edge/API Gateway/WAF/Envoy 做入口治理。
- API Service 无状态，按租户限流。
- Device Relay 水平扩展，按 device_id 或 tenant_id 分片。
- Orchestrator 事件驱动，任务状态落库，worker 可水平扩展。
- Kimi Gateway 做请求预算、队列、退避重试、熔断和模型限流。
- Redis Cluster 处理短期状态和限流。
- NATS/Kafka 分区承载事件面高吞吐。
- 对象存储承载文件面，不让 API 服务转发大文件。
- PostgreSQL 先按 tenant_id、created_at、task_id 设计索引；后续分区或分库。
- ClickHouse 承载审计和分析，不压主库。

## 7. 当前代码处理规则

当前 Spark 已经开始生成 Node.js MVP-0 PoC 文件。处理规则：

- 不回退、不删除，先保留为 `MVP-0 local host/core`。
- 不再继续扩展成正式 UI 或正式后端。
- 只允许做最小测试和修复，确保它能作为 PoC 证明本地文件安全模型。
- 正式 MVP-1 的新代码应放入 `apps/windows-client/`、`apps/local-agent/`、`services/`、`infra/`。

## 8. 下一步

1. 保留并验证 MVP-0 Node PoC。
2. 新增正式文档：`docs/mvp-1-windows-c-cloud-architecture.md`。
3. 按 MVP-1 新建目录骨架，但先不要引入沉重依赖。
4. 第一批 MVP-1 代码优先做：
   - `apps/local-agent` 的 workspace/path policy/file tools/journal。
   - `services/api` 的最小多租户数据模型和任务 API。
   - `services/orchestrator` 的任务状态机接口。
   - `services/kimi-gateway` 的 Kimi 调用边界。
