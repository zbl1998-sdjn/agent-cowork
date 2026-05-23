# Agent Cowork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `C:\Users\Administrator\Desktop\agent cowork` 实现一个只面向 Kimi 的本地 Cowork 产品 MVP：用本机 Kimi Code CLI 提供 agent 能力，用本地桌面/网页壳提供本地文件工作台、会话、目录信任、审批、审计、插件与 Skills 管理。

**Architecture:** MVP 不复制 Claude 的私有二进制、目录格式、VM bundle 或服务协议，只做 clean-room 的功能复刻。第一阶段用本机 `kimi.exe`、`kimi web`、`kimi acp`/Wire 能力构建本地 session manager、文件树/文件上下文服务、diff/apply pipeline、command runner 和受控 Web UI；VM/Hyper-V 隔离放到第二阶段，等 MVP 的权限、审计和 Kimi 集成跑通后再加。

**Tech Stack:** Windows 11 + Kimi Code CLI 1.39.0 + Node.js/TypeScript + React/Vite + Electron desktop shell + Vitest + JSONL/JSON local state. 纯聊天或 API-only 能力使用 Moonshot/Kimi OpenAI-compatible API，`base_url=https://api.moonshot.ai/v1`，密钥只从环境变量或系统凭据读取。

---

## 0. 当前本机事实

- 目标项目目录：`C:\Users\Administrator\Desktop\agent cowork`，当前为空。
- 本机 Kimi CLI：`C:\Users\Administrator\.local\bin\kimi.exe`。
- `kimi --version` 输出：`kimi, version 1.39.0`。
- `kimi info` 输出：`kimi-cli version: 1.39.0`，`wire protocol: 1.9`，`python version: 3.13.13`。
- 本机已有 Kimi runtime 目录：`C:\Users\Administrator\.kimi`，包含 `config.toml`、`credentials`、`sessions`、`logs`、`plans`、`kimi.json` 等。
- Kimi 官方文档说明 CLI runtime 默认在 `~/.kimi/`，会话包含 `context.jsonl`、`wire.jsonl`、`state.json`；`KIMI_SHARE_DIR` 可自定义 runtime 目录，但不影响 Skills 搜索路径。
- Kimi 官方 Web UI 默认 `http://127.0.0.1:5494`，支持 `--host`、`--port`、`--no-open`、`--auth-token`、`--allowed-origins`、`--restrict-sensitive-apis` 等参数。

## 1. Product Boundary

### 必须做

- Kimi-only：所有 agent 能力来自 `kimi` CLI、Kimi Web UI、Kimi ACP/Wire 或 Moonshot/Kimi API。
- 本地目录信任：用户选择的 workspace 默认不可信，必须显式信任后才能执行写入、shell、MCP、插件工具。
- 本地文件工作台：用户可以选择/挂载本地文件夹，查看 trusted workspace 内文件树，搜索文件，把文件或子目录加入当前 session 上下文。
- 受控文件读取：只读取 trusted workspace 内的文件；默认拦截凭据目录、隐藏敏感目录、大文件和二进制文件，用户确认后才允许加入上下文。
- 会话管理：记录 Agent Cowork 自己的 session 元数据、审计日志、上传/输出目录，不直接改写 `~/.kimi/sessions`。
- Diff/apply pipeline：Kimi 生成的修改先进入 diff 预览，用户批准后才写入本地文件；每次 apply 记录变更摘要、文件路径、hash 和审批事件。
- 本地 command runner：Kimi 可以提出在 trusted workspace 中运行命令；执行前必须审批，执行时有 timeout、输出截断和 audit 记录。
- 审批流：默认禁止 `kimi --yolo`，把写文件、执行命令、网络访问、MCP 工具调用、插件工具调用做成可审计的审批事件。
- 本地 Web UI 启动器：用安全参数启动 `kimi web`，默认只绑定 `127.0.0.1`，生成随机 `--auth-token`，禁止公网暴露。
- Kimi Skills/Plugins/MCP 管理入口：读取和展示配置，新增/删除操作必须走审批和审计。
- 可回放日志：每个 Cowork session 有 `audit.jsonl`、`events.jsonl`、`metadata.json`，敏感 token 不落日志。

### 明确不做进 MVP

- 不复刻 Claude 的 `cowork-svc.exe`、VHDX、VM bundle、命名管道协议或本地 agent session schema。
- 不复制 `C:\Users\Administrator\AppData\Local\Packages\Claude_pzs8sxrjxfjjc` 下任何文件、配置、插件、schema、日志或二进制。
- 不改动 `C:\Users\Administrator\.kimi\credentials` 内容，不读取 token 明文，不把 API Key 写进源码。
- 不把整个本地文件夹无差别上传到云端。Cowork 只把用户选中的文件片段、摘要、diff 或必要上下文交给 Kimi。
- 不默认开启公网访问，不使用 `kimi web --network`，不使用 `--dangerously-omit-auth`。
- 不在第一阶段实现完整 VM 隔离。MVP 先做进程级边界、路径信任、审批和审计；第二阶段再评估 Windows Sandbox、WSL2 或 Hyper-V。

## 2. Target File Structure

```text
C:\Users\Administrator\Desktop\agent cowork\
├── README.md
├── package.json
├── package-lock.json
├── tsconfig.base.json
├── .gitignore
├── docs\
│   ├── architecture.md
│   ├── security-model.md
│   ├── data-model.md
│   └── runbook.md
├── apps\
│   ├── host\
│   │   ├── package.json
│   │   ├── src\
│   │   │   ├── main.ts
│   │   │   ├── server.ts
│   │   │   ├── routes\
│   │   │   │   ├── health.ts
│   │   │   │   ├── sessions.ts
│   │   │   │   ├── trust.ts
│   │   │   │   ├── files.ts
│   │   │   │   ├── context.ts
│   │   │   │   ├── diff.ts
│   │   │   │   ├── commands.ts
│   │   │   │   └── kimi-web.ts
│   │   │   ├── kimi\
│   │   │   │   ├── cli-detect.ts
│   │   │   │   ├── kimi-web-process.ts
│   │   │   │   └── protocol-info.ts
│   │   │   ├── workspace\
│   │   │   │   ├── file-tree.ts
│   │   │   │   ├── file-reader.ts
│   │   │   │   ├── context-bundle.ts
│   │   │   │   ├── diff-service.ts
│   │   │   │   └── command-runner.ts
│   │   │   ├── storage\
│   │   │   │   ├── app-home.ts
│   │   │   │   ├── json-store.ts
│   │   │   │   └── jsonl-writer.ts
│   │   │   └── security\
│   │   │       ├── token.ts
│   │   │       ├── path-policy.ts
│   │   │       └── redaction.ts
│   │   └── tests\
│   ├── web\
│   │   ├── package.json
│   │   ├── index.html
│   │   └── src\
│   │       ├── App.tsx
│   │       ├── api.ts
│   │       ├── views\
│   │       │   ├── WorkspaceView.tsx
│   │       │   ├── FilesView.tsx
│   │       │   ├── DiffView.tsx
│   │       │   ├── CommandView.tsx
│   │       │   ├── SessionsView.tsx
│   │       │   ├── PolicyView.tsx
│   │       │   └── LogsView.tsx
│   │       └── styles.css
│   └── desktop\
│       ├── package.json
│       └── src\
│           ├── main.ts
│           └── preload.ts
├── packages\
│   ├── shared\
│   │   ├── package.json
│   │   └── src\
│   │       ├── types.ts
│   │       └── schemas.ts
│   └── policy\
│       ├── package.json
│       └── src\
│           ├── approval.ts
│           ├── trust-store.ts
│           └── command-policy.ts
└── plugins\
    └── kimi-cowork\
        ├── plugin.json
        └── scripts\
            └── session_summary.ts
```

## 3. Data Layout

Agent Cowork 自己的数据目录默认使用：

```text
%APPDATA%\KimiCowork\
├── config.json
├── trusted-roots.json
├── sessions\
│   └── <cowork-session-id>\
│       ├── metadata.json
│       ├── audit.jsonl
│       ├── events.jsonl
│       ├── context.json
│       ├── pending-diffs\
│       ├── outputs\
│       └── uploads\
└── logs\
    └── host.log
```

如果设置 `KIMI_COWORK_HOME`，则使用该目录替代 `%APPDATA%\KimiCowork`。Kimi Code CLI 自己的 runtime 仍使用 `~/.kimi` 或用户指定的 `KIMI_SHARE_DIR`，Agent Cowork 只通过公开 CLI/API 与它交互。

## 4. Implementation Tasks

### Task 1: Initialize The Workspace

**Files:**
- Create: `C:\Users\Administrator\Desktop\agent cowork\README.md`
- Create: `C:\Users\Administrator\Desktop\agent cowork\package.json`
- Create: `C:\Users\Administrator\Desktop\agent cowork\tsconfig.base.json`
- Create: `C:\Users\Administrator\Desktop\agent cowork\.gitignore`
- Create: `C:\Users\Administrator\Desktop\agent cowork\docs\architecture.md`
- Create: `C:\Users\Administrator\Desktop\agent cowork\docs\security-model.md`

- [ ] **Step 1: Initialize git and npm workspace**

Run from `C:\Users\Administrator\Desktop\agent cowork`:

```powershell
git init
npm init -y
```

Expected:

```text
Initialized empty Git repository
Wrote to package.json
```

- [ ] **Step 2: Replace root `package.json` with workspace metadata**

Write this exact root file:

```json
{
  "name": "kimi-cowork",
  "version": "0.1.0",
  "private": true,
  "description": "Kimi-only local cowork desktop and web shell",
  "type": "module",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces",
    "test": "npm run test --workspaces",
    "lint": "npm run lint --workspaces",
    "dev:host": "npm --workspace apps/host run dev",
    "dev:web": "npm --workspace apps/web run dev",
    "dev:desktop": "npm --workspace apps/desktop run dev"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 3: Add TypeScript baseline**

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noUncheckedIndexedAccess": true
  }
}
```

- [ ] **Step 4: Add ignore rules**

Create `.gitignore`:

```gitignore
node_modules/
dist/
.vite/
.env
.env.*
*.log
coverage/
KimiCoworkData/
```

- [ ] **Step 5: Install dependencies after approval**

Run only after dependency-download approval:

```powershell
npm install -D typescript tsx vitest @types/node
npm install -D eslint @eslint/js typescript-eslint
```

Expected:

```text
added ...
found 0 vulnerabilities
```

- [ ] **Step 6: Commit workspace scaffold**

```powershell
git status --short
git add README.md package.json package-lock.json tsconfig.base.json .gitignore docs
git commit -m "chore: scaffold agent cowork workspace"
```

### Task 2: Define Shared Types And Schemas

**Files:**
- Create: `packages\shared\package.json`
- Create: `packages\shared\src\types.ts`
- Create: `packages\shared\src\schemas.ts`
- Create: `packages\shared\tests\schemas.test.ts`

- [ ] **Step 1: Create package metadata**

```json
{
  "name": "@kimi-cowork/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "eslint src tests"
  },
  "devDependencies": {}
}
```

- [ ] **Step 2: Add exact domain types**

`types.ts` must define:

```ts
export type TrustState = "trusted" | "untrusted";
export type ApprovalKind = "file_write" | "shell_command" | "network" | "mcp_tool" | "plugin_tool";
export type ApprovalDecision = "approved" | "denied";

export interface TrustedRoot {
  id: string;
  path: string;
  state: TrustState;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface CoworkSession {
  id: string;
  title: string;
  workspacePath: string;
  kimiSessionId: string | null;
  kimiWebPort: number | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface AuditEvent {
  id: string;
  sessionId: string;
  at: string;
  kind: "approval" | "process" | "filesystem" | "policy" | "error";
  message: string;
  redacted: boolean;
  data: Record<string, unknown>;
}

export interface ApprovalEvent {
  id: string;
  sessionId: string;
  kind: ApprovalKind;
  subject: string;
  decision: ApprovalDecision;
  reason: string;
  createdAt: string;
}
```

- [ ] **Step 3: Add runtime validators without leaking secrets**

Use a small local validator first, then consider `zod` only if validation grows. The first implementation can be pure TypeScript functions:

```ts
import type { CoworkSession, TrustedRoot } from "./types.js";

export function assertTrustedRoot(value: unknown): asserts value is TrustedRoot {
  if (!value || typeof value !== "object") {
    throw new Error("TrustedRoot must be an object");
  }
  const root = value as Record<string, unknown>;
  if (typeof root.id !== "string" || root.id.length === 0) {
    throw new Error("TrustedRoot.id must be a non-empty string");
  }
  if (typeof root.path !== "string" || root.path.length === 0) {
    throw new Error("TrustedRoot.path must be a non-empty string");
  }
  if (root.state !== "trusted" && root.state !== "untrusted") {
    throw new Error("TrustedRoot.state must be trusted or untrusted");
  }
}

export function assertCoworkSession(value: unknown): asserts value is CoworkSession {
  if (!value || typeof value !== "object") {
    throw new Error("CoworkSession must be an object");
  }
  const session = value as Record<string, unknown>;
  if (typeof session.id !== "string" || session.id.length === 0) {
    throw new Error("CoworkSession.id must be a non-empty string");
  }
  if (typeof session.workspacePath !== "string" || session.workspacePath.length === 0) {
    throw new Error("CoworkSession.workspacePath must be a non-empty string");
  }
}
```

- [ ] **Step 4: Test validators**

```ts
import { describe, expect, it } from "vitest";
import { assertCoworkSession, assertTrustedRoot } from "../src/schemas.js";

describe("shared schemas", () => {
  it("accepts valid trusted roots", () => {
    expect(() => assertTrustedRoot({
      id: "root-1",
      path: "C:\\Users\\Administrator\\Desktop\\agent cowork",
      state: "trusted",
      createdAt: "2026-05-20T00:00:00.000Z",
      lastUsedAt: null
    })).not.toThrow();
  });

  it("rejects missing session workspace paths", () => {
    expect(() => assertCoworkSession({ id: "s1" })).toThrow("workspacePath");
  });
});
```

Run:

```powershell
npm --workspace packages/shared run test
npm --workspace packages/shared run build
```

Expected: both commands pass.

### Task 3: Implement Kimi CLI Detection

**Files:**
- Create: `apps\host\package.json`
- Create: `apps\host\src\kimi\cli-detect.ts`
- Create: `apps\host\src\kimi\protocol-info.ts`
- Create: `apps\host\tests\cli-detect.test.ts`

- [ ] **Step 1: Create host package**

```json
{
  "name": "@kimi-cowork/host",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx src/main.ts",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "eslint src tests"
  },
  "dependencies": {
    "@kimi-cowork/shared": "0.1.0"
  },
  "devDependencies": {}
}
```

- [ ] **Step 2: Detect Kimi without reading credentials**

`cli-detect.ts`:

```ts
import { spawn } from "node:child_process";

export interface KimiCliInfo {
  executable: string;
  version: string;
}

export async function detectKimiCli(executable = "kimi"): Promise<KimiCliInfo> {
  const output = await runAndCapture(executable, ["--version"]);
  const match = output.match(/version\s+([0-9]+\.[0-9]+\.[0-9]+)/);
  if (!match) {
    throw new Error(`Unable to parse kimi version from: ${output}`);
  }
  return { executable, version: match[1] };
}

function runAndCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(`kimi command failed with code ${code}: ${stderr.trim()}`));
    });
  });
}
```

- [ ] **Step 3: Parse protocol info**

`protocol-info.ts`:

```ts
export interface KimiProtocolInfo {
  cliVersion: string;
  wireProtocol: string;
  pythonVersion: string;
}

export function parseKimiInfo(output: string): KimiProtocolInfo {
  const cliVersion = requiredMatch(output, /kimi-cli version:\s*([^\r\n]+)/, "cli version");
  const wireProtocol = requiredMatch(output, /wire protocol:\s*([^\r\n]+)/, "wire protocol");
  const pythonVersion = requiredMatch(output, /python version:\s*([^\r\n]+)/, "python version");
  return { cliVersion, wireProtocol, pythonVersion };
}

function requiredMatch(input: string, pattern: RegExp, label: string): string {
  const match = input.match(pattern);
  if (!match) {
    throw new Error(`Missing ${label} in kimi info output`);
  }
  return match[1].trim();
}
```

- [ ] **Step 4: Test parser with current machine output**

```ts
import { describe, expect, it } from "vitest";
import { parseKimiInfo } from "../src/kimi/protocol-info.js";

describe("parseKimiInfo", () => {
  it("parses current Kimi CLI protocol output", () => {
    const info = parseKimiInfo([
      "kimi-cli version: 1.39.0",
      "agent spec versions: 1",
      "wire protocol: 1.9",
      "python version: 3.13.13"
    ].join("\n"));

    expect(info).toEqual({
      cliVersion: "1.39.0",
      wireProtocol: "1.9",
      pythonVersion: "3.13.13"
    });
  });
});
```

Run:

```powershell
npm --workspace apps/host run test
```

Expected: parser test passes.

### Task 4: Implement Local Storage And Audit Logs

**Files:**
- Create: `apps\host\src\storage\app-home.ts`
- Create: `apps\host\src\storage\json-store.ts`
- Create: `apps\host\src\storage\jsonl-writer.ts`
- Create: `apps\host\tests\storage.test.ts`

- [ ] **Step 1: Resolve app data home**

`app-home.ts`:

```ts
import { join } from "node:path";

export function getCoworkHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KIMI_COWORK_HOME && env.KIMI_COWORK_HOME.trim().length > 0) {
    return env.KIMI_COWORK_HOME;
  }
  const appData = env.APPDATA;
  if (!appData) {
    throw new Error("APPDATA is not set and KIMI_COWORK_HOME was not provided");
  }
  return join(appData, "KimiCowork");
}
```

- [ ] **Step 2: Write atomic JSON store**

`json-store.ts` must write `*.tmp` then rename into place. It must create parent directories with `recursive: true` and never stringify secrets passed through redaction.

- [ ] **Step 3: Write append-only JSONL audit writer**

`jsonl-writer.ts` must append one compact JSON object per line. It must reject values containing keys named `token`, `apiKey`, `authorization`, `password`, or `secret` unless already replaced with `[REDACTED]`.

- [ ] **Step 4: Test home override and redaction guard**

Create tests that set `KIMI_COWORK_HOME` to a temp directory and verify:

```text
getCoworkHome({ KIMI_COWORK_HOME: "C:\\tmp\\kcw", APPDATA: "C:\\Users\\Administrator\\AppData\\Roaming" })
```

returns:

```text
C:\tmp\kcw
```

Also verify writing `{ token: "abc" }` fails, while `{ token: "[REDACTED]" }` succeeds.

Run:

```powershell
npm --workspace apps/host run test
```

Expected: storage tests pass and no credential values are printed.

### Task 5: Implement Trust And Approval Policy

**Files:**
- Create: `packages\policy\package.json`
- Create: `packages\policy\src\trust-store.ts`
- Create: `packages\policy\src\approval.ts`
- Create: `packages\policy\src\command-policy.ts`
- Create: `packages\policy\tests\policy.test.ts`

- [ ] **Step 1: Define trust matching**

Trust matching must canonicalize paths with `path.resolve`, compare case-insensitively on Windows, and only mark a path trusted when it is equal to or inside a trusted root.

- [ ] **Step 2: Define approval defaults**

Default decisions:

```text
file_write: deny until user approves
shell_command: deny until user approves
network: deny until user approves
mcp_tool: deny until user approves
plugin_tool: deny until user approves
read_only_file: allow inside trusted root, deny outside trusted root
```

- [ ] **Step 3: Block dangerous Kimi Web flags**

`command-policy.ts` must reject:

```text
kimi web --network
kimi web --dangerously-omit-auth
kimi web --public
```

unless a future explicit admin policy enables them. MVP admin policy default is disabled.

- [ ] **Step 4: Test trust boundary**

Test cases:

```text
trusted root: C:\Users\Administrator\Desktop\agent cowork\workspace
allowed:      C:\Users\Administrator\Desktop\agent cowork\workspace\src\a.ts
denied:       C:\Users\Administrator\Desktop\agent cowork-other\a.ts
denied:       C:\Users\Administrator\.kimi\credentials\provider.json
```

Run:

```powershell
npm --workspace packages/policy run test
```

Expected: all policy tests pass.

### Task 6: Start And Stop Kimi Web Safely

**Files:**
- Create: `apps\host\src\kimi\kimi-web-process.ts`
- Create: `apps\host\src\security\token.ts`
- Create: `apps\host\src\routes\kimi-web.ts`
- Create: `apps\host\tests\kimi-web-process.test.ts`

- [ ] **Step 1: Generate bearer token**

Use `crypto.randomBytes(32).toString("hex")`. Never log the full token. Logs may include only the first 8 characters plus `[REDACTED]`.

- [ ] **Step 2: Start Kimi Web with safe defaults**

The process args must be:

```ts
[
  "web",
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
  "--no-open",
  "--auth-token",
  token,
  "--allowed-origins",
  allowedOrigin
]
```

Do not pass `--network`, `--public`, `--dangerously-omit-auth`, or `--no-restrict-sensitive-apis`.

- [ ] **Step 3: Stop process on session close**

On Windows, first send a normal termination signal. If the process stays alive after 5 seconds, kill the child process tree using a narrowly targeted process id. Do not kill all `kimi.exe` processes.

- [ ] **Step 4: Test args without launching real Kimi**

Inject a fake spawn function and assert:

```text
args include --host 127.0.0.1
args include --auth-token <generated>
args do not include --network
args do not include --dangerously-omit-auth
```

Run:

```powershell
npm --workspace apps/host run test
```

Expected: Kimi Web process tests pass without launching a real server.

### Task 7: Implement Host HTTP API

**Files:**
- Create: `apps\host\src\server.ts`
- Create: `apps\host\src\main.ts`
- Create: `apps\host\src\routes\health.ts`
- Create: `apps\host\src\routes\sessions.ts`
- Create: `apps\host\src\routes\trust.ts`
- Create: `apps\host\tests\server.test.ts`

- [ ] **Step 1: Use Node built-in HTTP server**

Avoid Express in MVP. Keep the API small:

```text
GET  /health
GET  /api/kimi/info
GET  /api/sessions
POST /api/sessions
POST /api/sessions/:id/archive
GET  /api/trusted-roots
POST /api/trusted-roots
POST /api/kimi-web/start
POST /api/kimi-web/stop
GET  /api/audit/:sessionId
```

- [ ] **Step 2: Validate every request body**

Reject invalid JSON with HTTP 400 and a compact error:

```json
{"error":"invalid_json"}
```

Reject untrusted workspace paths with HTTP 403:

```json
{"error":"workspace_not_trusted"}
```

- [ ] **Step 3: Add health response**

`GET /health` returns:

```json
{
  "ok": true,
  "service": "kimi-cowork-host"
}
```

- [ ] **Step 4: Test API behavior**

Tests must cover:

```text
GET /health returns 200
POST /api/sessions rejects untrusted workspace
POST /api/kimi-web/start rejects unsafe port payload
GET /api/kimi/info returns parsed Kimi CLI version when detector is injected
```

Run:

```powershell
npm --workspace apps/host run test
npm --workspace apps/host run build
```

Expected: tests and TypeScript build pass.

### Task 8: Build The Web UI

**Files:**
- Create: `apps\web\package.json`
- Create: `apps\web\index.html`
- Create: `apps\web\src\App.tsx`
- Create: `apps\web\src\api.ts`
- Create: `apps\web\src\views\WorkspaceView.tsx`
- Create: `apps\web\src\views\SessionsView.tsx`
- Create: `apps\web\src\views\PolicyView.tsx`
- Create: `apps\web\src\views\LogsView.tsx`
- Create: `apps\web\src\styles.css`

- [ ] **Step 1: Use an app surface, not a landing page**

First screen layout:

```text
left sidebar: Workspaces, Sessions, Policy, Logs
top bar: Kimi CLI status, Web UI status, current trusted workspace
main panel: selected workflow
right panel: pending approvals and latest audit events
```

- [ ] **Step 2: Add workspace trust workflow**

The user can select a local folder, see `trusted` or `untrusted`, and click `Trust workspace`. The UI calls `POST /api/trusted-roots`; the host writes `trusted-roots.json` and appends an audit event.

- [ ] **Step 3: Add Kimi Web launch workflow**

The UI shows a `Start Kimi Web` button only after the workspace is trusted. It calls `POST /api/kimi-web/start`. On success it renders an iframe or opens an internal route pointing at:

```text
http://127.0.0.1:<port>
```

The bearer token stays in the host process and is never displayed in UI text.

- [ ] **Step 4: Add session list**

Show session title, workspace path, archived flag, Kimi Web port, created time, updated time. Archive is soft-delete only.

- [ ] **Step 5: Test with component tests**

Use Vitest + React Testing Library only after dependency approval:

```powershell
npm install -D @testing-library/react @testing-library/jest-dom jsdom
npm --workspace apps/web run test
npm --workspace apps/web run build
```

Expected: tests pass and Vite build emits `dist`.

### Task 9: Build Electron Desktop Shell

**Files:**
- Create: `apps\desktop\package.json`
- Create: `apps\desktop\src\main.ts`
- Create: `apps\desktop\src\preload.ts`
- Create: `apps\desktop\tests\desktop-config.test.ts`

- [ ] **Step 1: Install Electron after approval**

```powershell
npm install -D electron wait-on concurrently
```

- [ ] **Step 2: Start host and web UI as child processes in dev**

`npm --workspace apps/desktop run dev` must:

```text
start @kimi-cowork/host
start @kimi-cowork/web
open Electron BrowserWindow to the local web UI
```

- [ ] **Step 3: Harden BrowserWindow**

Use:

```ts
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  preload: preloadPath
}
```

Do not expose arbitrary shell execution over IPC.

- [ ] **Step 4: Desktop smoke test**

Run:

```powershell
npm run dev:host
npm run dev:web
npm run dev:desktop
```

Expected:

```text
host listens on 127.0.0.1
web UI opens in Electron
Kimi CLI status shows 1.39.0
Start Kimi Web is disabled until a workspace is trusted
```

### Task 10: Add Kimi Skills And Plugin Integration

**Files:**
- Create: `.kimi\skills\kimi-cowork\SKILL.md`
- Create: `plugins\kimi-cowork\plugin.json`
- Create: `plugins\kimi-cowork\scripts\session_summary.ts`
- Create: `docs\kimi-extension-model.md`

- [ ] **Step 1: Add project-level Skill**

The Skill should instruct Kimi agents inside this project to:

```text
respect Agent Cowork trust roots
avoid --yolo unless explicitly requested
summarize file writes before asking approval
avoid reading credentials directories
emit concise session summaries
```

- [ ] **Step 2: Add plugin skeleton**

`plugin.json`:

```json
{
  "name": "kimi-cowork",
  "version": "0.1.0",
  "description": "Local helpers for Agent Cowork session inspection",
  "tools": [
    {
      "name": "session_summary",
      "description": "Summarize a Agent Cowork session audit log",
      "command": ["node", "scripts/session_summary.js"],
      "parameters": {
        "type": "object",
        "properties": {
          "sessionId": {
            "type": "string",
            "description": "Agent Cowork session id"
          }
        },
        "required": ["sessionId"]
      }
    }
  ]
}
```

- [ ] **Step 3: Install plugin only after user approval**

```powershell
kimi plugin install "C:\Users\Administrator\Desktop\agent cowork\plugins\kimi-cowork"
kimi plugin list
```

Expected: plugin list includes `kimi-cowork`.

### Task 11: Verification And Acceptance

**Files:**
- Create: `docs\runbook.md`
- Modify: `README.md`

- [ ] **Step 1: Static verification**

```powershell
npm run build
npm run test
npm run lint
```

Expected: all pass.

- [ ] **Step 2: Local runtime verification**

```powershell
kimi --version
kimi info
npm run dev:host
```

Expected:

```text
kimi, version 1.39.0
wire protocol: 1.9
host health endpoint returns {"ok":true,"service":"kimi-cowork-host"}
```

- [ ] **Step 3: Kimi Web launch verification**

From the UI or API, start Kimi Web for a trusted workspace. Then verify:

```powershell
Get-NetTCPConnection -LocalPort 5494 -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,State,OwningProcess
```

Expected:

```text
LocalAddress is 127.0.0.1
State is Listen
```

If port `5494` is occupied, the host selects an available port in `5494-5503` and records it in session metadata.

- [ ] **Step 4: Security acceptance**

Confirm:

```text
No source file contains MOONSHOT_API_KEY
No source file contains OAuth token values
Kimi Web was not started with --network
Kimi Web was not started with --dangerously-omit-auth
Untrusted workspace cannot start a session
Audit log redacts token, apiKey, authorization, password, secret
```

Useful commands:

```powershell
git grep -n "MOONSHOT_API_KEY"
git grep -n "dangerously-omit-auth"
git grep -n "--network"
```

Expected: first command only finds documentation examples; unsafe flags are present only in tests or docs as blocked cases.

## 5. Second-Stage Isolation Plan

Do this only after MVP is stable:

1. Add a process sandbox abstraction with three implementations: `none`, `wsl`, `windows-sandbox`.
2. Move file mutations into a mounted workspace copy or controlled worktree.
3. Add egress policy with allowlisted domains and per-session approvals.
4. Add MCP tool policy that maps server name + tool name to approval rules.
5. Add crash recovery: orphan child process detection, stale port cleanup, session resume.
6. Add packaging: signed installer, auto-update disabled by default until signing and rollback are verified.

## 6. Source References

- Kimi API Overview: https://platform.kimi.ai/docs/api/overview
- Kimi Code data paths: https://www.kimi.com/code/docs/kimi-code-cli/configuration/data-locations.html
- Kimi Code Web UI: https://www.kimi.com/code/docs/kimi-code-cli/reference/kimi-web.html
- Kimi Code Skills: https://www.kimi.com/code/docs/kimi-code-cli/customization/skills.html
- Kimi Code custom plugins: https://www.kimi.com/code/docs/kimi-code-cli/customization/plugins.html

## 7. Execution Recommendation

Start with Tasks 1-4 in one small implementation batch. That creates a repo, typed model, Kimi CLI detection, storage, and audit safety without touching desktop packaging. After that, implement Tasks 5-7 so the host can safely start and stop Kimi Web. UI and Electron should come after the host API passes tests.
