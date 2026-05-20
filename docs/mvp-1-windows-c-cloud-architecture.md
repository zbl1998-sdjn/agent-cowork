# MVP-1 Windows C Client + Cloud Backend Implementation Plan

> **Goal:** 把 Kimi Cowork 从本地 PoC 升级为正式 Windows 产品架构：C-first Windows 客户端、本地 Agent、多用户云端后端、任务编排、Kimi Gateway，并保留长期千万级 QPS 演进路径。

## 1. Product Scope

MVP-1 必须面向普通 Windows 用户，而不是只面向已经安装 Kimi Code CLI 的开发者。

首版必须支持：

- 用户登录。
- 设备注册。
- 选择本地 workspace。
- 本地文件树和授权范围管理。
- Kimi 生成任务计划。
- 本地 Agent 安全读取授权文件。
- 生成报告、表格、引用和文件操作预览。
- 用户审批后执行 write/rename/move。
- Journal 记录和基础回滚。
- 多用户、多设备、多租户数据模型。

首版不做：

- 全盘扫描。
- 自动删除文件。
- 未审批 shell。
- 插件市场。
- 复杂企业 SSO。
- 真正千万级压测。
- 多区域生产部署。

## 2. Repository Layout

```text
kimi-cowork/
├── apps/
│   ├── windows-client/
│   │   ├── CMakeLists.txt
│   │   ├── src/
│   │   │   ├── main.c
│   │   │   ├── app_window.c
│   │   │   ├── app_window.h
│   │   │   ├── tray.c
│   │   │   ├── tray.h
│   │   │   ├── webview_bridge.cpp
│   │   │   ├── webview_bridge.h
│   │   │   ├── native_bridge.c
│   │   │   ├── native_bridge.h
│   │   │   ├── auth.c
│   │   │   ├── auth.h
│   │   │   ├── workspace.c
│   │   │   ├── workspace.h
│   │   │   ├── ipc.c
│   │   │   ├── ipc.h
│   │   │   ├── net.c
│   │   │   ├── net.h
│   │   │   ├── json.c
│   │   │   └── json.h
│   │   └── resources/
│   │       ├── index.html
│   │       ├── app.css
│   │       └── app.js
│   └── local-agent/
│       ├── go.mod
│       ├── cmd/kimi-cowork-agent/main.go
│       └── internal/
│           ├── workspace/
│           ├── tools/
│           ├── journal/
│           ├── relay/
│           └── policy/
├── services/
│   ├── api/
│   ├── relay/
│   ├── orchestrator/
│   ├── kimi-gateway/
│   └── workers/
├── packages/
│   └── proto/
├── infra/
│   ├── docker-compose.yml
│   └── k8s/
└── docs/
    ├── architecture.md
    ├── security-model.md
    ├── qps-scaling.md
    ├── data-model.md
    └── runbook.md
```

## 3. Windows Client Tasks

### Task W1: C/Win32 Window Shell

**Files:**
- Create: `apps/windows-client/CMakeLists.txt`
- Create: `apps/windows-client/src/main.c`
- Create: `apps/windows-client/src/app_window.c`
- Create: `apps/windows-client/src/app_window.h`

Acceptance:

```text
cmake -S apps/windows-client -B build/windows-client
cmake --build build/windows-client
```

Expected:

```text
KimiCowork.exe builds and opens a native Windows window.
```

### Task W2: WebView2 Bridge

**Files:**
- Create: `apps/windows-client/src/webview_bridge.cpp`
- Create: `apps/windows-client/src/webview_bridge.h`
- Create: `apps/windows-client/src/native_bridge.c`
- Create: `apps/windows-client/src/native_bridge.h`
- Create: `apps/windows-client/resources/index.html`
- Create: `apps/windows-client/resources/app.css`
- Create: `apps/windows-client/resources/app.js`

Acceptance:

```text
The native window hosts WebView2.
The page can call native bridge methods for app version, workspace picker, and local agent status.
No arbitrary shell execution is exposed to WebView JavaScript.
```

### Task W3: Workspace Picker

**Files:**
- Create: `apps/windows-client/src/workspace.c`
- Create: `apps/windows-client/src/workspace.h`

Acceptance:

```text
User can choose a folder.
Client sends the chosen folder to Local Agent for trust registration.
Client never grants full-disk access.
```

## 4. Local Agent Tasks

### Task A1: Agent Skeleton

**Files:**
- Create: `apps/local-agent/go.mod`
- Create: `apps/local-agent/cmd/kimi-cowork-agent/main.go`

Acceptance:

```powershell
go test ./...
go run ./cmd/kimi-cowork-agent --help
```

Expected:

```text
Agent starts, prints version, and exposes localhost health endpoint or named-pipe status.
```

### Task A2: Workspace Policy

**Files:**
- Create: `apps/local-agent/internal/policy/path_policy.go`
- Create: `apps/local-agent/internal/policy/path_policy_test.go`

Rules:

```text
realpath(target) == realpath(trustedRoot)
or target is under trustedRoot
```

Reject:

```text
%USERPROFILE%\.ssh
%USERPROFILE%\.kimi\credentials
%APPDATA%
.env
*.pem
*.key
id_rsa
```

### Task A3: File Tools

**Files:**
- Create: `apps/local-agent/internal/tools/list_files.go`
- Create: `apps/local-agent/internal/tools/read_file.go`
- Create: `apps/local-agent/internal/tools/hash_file.go`
- Create: `apps/local-agent/internal/tools/file_tools_test.go`

Acceptance:

```text
list_files only lists trusted root.
read_file only reads text files under size limit.
hash_file returns sha256.
Sensitive files are blocked.
```

### Task A4: Journal And File Operations

**Files:**
- Create: `apps/local-agent/internal/journal/journal.go`
- Create: `apps/local-agent/internal/tools/file_operations.go`
- Create: `apps/local-agent/internal/tools/file_operations_test.go`

Support:

```text
write
rename
move
rollback metadata
```

Forbid:

```text
delete
overwrite by default
operate outside trusted root
```

## 5. Cloud Backend Tasks

### Task C1: API Service Skeleton

**Files:**
- Create: `services/api/go.mod`
- Create: `services/api/cmd/api/main.go`
- Create: `services/api/internal/http/routes.go`
- Create: `services/api/internal/model/types.go`

Minimum routes:

```text
GET  /health
POST /v1/devices
POST /v1/workspaces
GET  /v1/workspaces
POST /v1/tasks
GET  /v1/tasks/{task_id}
POST /v1/approvals/{approval_id}/decision
```

Every resource must carry:

```text
tenant_id
user_id
device_id when device-scoped
```

### Task C2: Device Relay Skeleton

**Files:**
- Create: `services/relay/go.mod`
- Create: `services/relay/cmd/relay/main.go`
- Create: `services/relay/internal/session/session.go`

Acceptance:

```text
Client connects with device_id.
Relay stores online session in memory for MVP.
Relay can route a tool request envelope to the device session.
```

### Task C3: Orchestrator State Machine

**Files:**
- Create: `services/orchestrator/go.mod`
- Create: `services/orchestrator/internal/state/task_state.go`
- Create: `services/orchestrator/internal/state/task_state_test.go`

States:

```text
created
planning
waiting_user_approval
running_tools
waiting_file_operation_approval
applying_file_operations
succeeded
failed
cancelled
```

### Task C4: Kimi Gateway

**Files:**
- Create: `services/kimi-gateway/go.mod`
- Create: `services/kimi-gateway/internal/kimi/client.go`
- Create: `services/kimi-gateway/internal/kimi/budget.go`
- Create: `services/kimi-gateway/internal/kimi/retry.go`

Rules:

```text
Kimi API key only exists in service env.
Client and local agent never receive raw Kimi API key.
Gateway attaches tenant/user/task metadata to logs.
Retries are bounded.
Timeouts are explicit.
```

## 6. Data Model

Core tables:

```text
tenants
users
devices
workspaces
tasks
task_events
approvals
file_operation_journals
artifacts
model_usage
```

Every task row must include:

```text
tenant_id
user_id
device_id
workspace_id
status
created_at
updated_at
idempotency_key
```

## 7. QPS Scaling Plan

Create `docs/qps-scaling.md` with four lanes:

```text
control plane: API metadata requests
event plane: relay, task events, tool events
file plane: object storage upload/download
model plane: Kimi Gateway requests
```

Scaling rules:

- API stateless behind Gateway/WAF/Envoy.
- Relay sharded by device_id or tenant_id.
- Orchestrator event-driven through NATS/Kafka.
- Model requests queued and rate-limited per tenant.
- Large files go through object storage signed URLs.
- Audit analytics go to ClickHouse, not PostgreSQL hot path.

## 8. MVP-1 First Implementation Batch

Do not start with UI polish. Start with the smallest architecture-compatible slice:

1. `apps/local-agent` path policy, file tools, journal.
2. `services/api` health + tenant/device/workspace/task structs.
3. `services/orchestrator` state machine tests.
4. `services/kimi-gateway` config, timeout, bounded retry skeleton.
5. `apps/windows-client` native empty window + workspace picker stub.

Verification:

```powershell
go test ./apps/local-agent/...
go test ./services/api/...
go test ./services/orchestrator/...
go test ./services/kimi-gateway/...
cmake -S apps/windows-client -B build/windows-client
cmake --build build/windows-client
```

