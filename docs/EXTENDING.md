# 扩展指南 (Extending Agent Cowork)

面向维护者：本项目的核心扩展点、契约与约定。目标是「加功能时只动一处、有清晰边界、有测试套路」。

## 架构总览

```
Tauri 2 桌面壳 (Rust)  ── frontendDist ──>  React UI (apps/windows-client/ui)
        │                                         │  fetch / SSE (CORS, loopback)
        │ externalBin sidecar                     ▼
        └──────────────>  Node host (apps/host)  ──>  OpenAI 兼容模型 API
                          组合根: src/server.js
```

- **Host（`apps/host`）**：零运行时依赖的 Node ESM 服务。组合根 `src/server.js` 负责装配存储、鉴权、并发限流、路由分发与优雅停机。
- **UI（`apps/windows-client/ui`）**：React 18 + Vite + TS。`src/lib/api.ts` 是唯一的 host 客户端，所有请求自动注入 `Authorization: Bearer`。
- **打包**：host 经 esbuild→CJS 再做 Node SEA 单文件 exe（sidecar）；UI 经 `tsc -b && vite build` 出 `ui-dist`；Tauri 打 MSI/NSIS。

## 扩展点 1：存储适配器 (Store Adapters)

所有持久化都走「同一接口、多后端」的 Ports & Adapters 模式。新增一类数据时，先定义接口，再写 file/postgres 两种实现。

以会话存储为例，接口是：

```
list(trustedRoot, ctx)                       -> summary[]
query(trustedRoot, ctx, { q, limit, offset }) -> { items, total }
listFull(trustedRoot, ctx, { limit })        -> fullDoc[]
get(trustedRoot, id, ctx)                    -> fullDoc | null
save(trustedRoot, doc, ctx)                  -> summary
remove(trustedRoot, id, ctx)                 -> boolean
```

约定：

- **租户隔离**：所有方法都接收 `ctx`（含 `tenantId`/`userId`），实现必须按二者隔离。绝不允许跨租户读写。
- **读路径 `await`**：file 适配器同步、postgres 适配器异步；调用方一律 `await`，对同步实现透明。
- **postgres 适配器**：`pg` 用动态 `import()` 懒加载（可选依赖）；构造函数接受 `{ pool }`（测试注入 mock）或 `{ connectionString }`。
- **选用**：在 `server.js` 按 `usePostgresState` 选择 `createPostgresXxxStore(...)` 或 file 版本，并允许 `config.xxxStore` 覆盖（测试用）。
- **迁移**：postgres 表加到 `src/storage/migrations-postgres/0001_init.sql`（外部 `psql -f` 应用，幂等 `IF NOT EXISTS`）。

参考实现：`storage/conversation-store.js`（file）+ `storage/postgres-conversation-store.js`（PG）。

## 扩展点 2：HTTP 路由 (Route Handlers)

每个路由模块导出一个 `handleXxxRoutes(args)`，**返回 `true` 表示已处理、`false` 表示放行给后续 handler**。在 `server.js` 的分发链按顺序注册。

```js
export async function handleFooRoutes({ request, response, pathname, requestUrl, requestContext, trustedRootDefault, fooStore }) {
  if (request.method === 'GET' && pathname === '/api/foo') {
    sendJson(response, 200, { ... });
    return true;
  }
  return false;
}
```

约定：

- **顺序敏感**：鉴权/CORS/安全头在分发前统一处理（见 `server.js` 请求入口）；handler 只管自己的路径。
- **受信根**：任何接收路径参数的端点必须经 `assertTrustedPath(resolved, trustedRootDefault)` 收敛到受信根内，防目录穿越。
- **请求体**：用 `withJsonBody(request, response, handler)`；它做 content-type 校验 + 1MB 体积上限（超限 413）+ JSON 解析错误（400）。
- **租户**：从 `requestContext.tenantId/userId` 取（已由入口根据 Bearer token 解析注入），不要自己解析 token。

## 扩展点 3：Agent 工具 (Tools)

Agent 循环在 `kimi/agent-runner.js`。工具集由 `agent-tools.js` 装配，模型通过 `ToolSearch` 懒加载按需注入，避免一次性灌入全部工具。新增工具：实现 `{ name, description, inputSchema, run }`，在工具注册表登记即可，无需改 agent 循环本身。

## 扩展点 4：鉴权与多租户

- **无状态 JWT**（`auth/jwt.js`，HS256，零依赖）跨实例可验；失败回退到 opaque session（`auth/user-store.js`）。
- 请求入口解析 `Authorization: Bearer`，把 `userId`/`tenantId` 写入 `requestContext`，所有下游据此隔离。
- 加新身份来源：实现一个 `resolveXxxIdentity(token)` 返回 `{ userId, tenantId }`，在入口的解析链里加一档。

## 安全基线（改动时不要破坏）

- **安全响应头**：`server.js` 的 `SECURITY_HEADERS` 对所有响应生效（nosniff / DENY 框架 / no-referrer / COOP / CORP）。
- **路径策略**：`security/path-policy.js` 的 `assertTrustedPath` 拒绝受信根外与系统敏感目录（如 Temp/AppData）。
- **CORS**：`isAllowedOrigin` 只放行 loopback 与 `tauri:`；恶意 Origin 不反射。
- **密钥**：Kimi API Key 只存 `.AgentCowork/config.json`（已 gitignore），接口只回 `hasKey` 布尔，永不回显明文。
- **CSP**：见 `src-tauri/tauri.conf.json`；PDF 内联预览依赖 `object-src/frame-src 'self' data:`。

## PostgreSQL 切换

设 `KCW_STORE=postgres` + `DATABASE_URL=...`，并先对库应用 `migrations-postgres/0001_init.sql`。host 会自动选用 PG 适配器、跨实例 SSE（LISTEN/NOTIFY）与跨实例审批。

## 测试约定

- 后端：`node --test`，测试放 `apps/host/test/test_*.js`。
- 工作区根用 `makeTestWorkspace(prefix)`（项目内非敏感目录）；**不要用系统 Temp**，会被 path-policy 拒。
- PG 适配器：注入 mock pool（见 `test/postgres-conversation-store.test.js`）。
- 前端：`vitest run`；类型 `tsc --noEmit`。
- 权威验证在真实 Windows 上执行（Linux 沙箱挂载偶发只读/读截断假象）。

## 构建与发布

- 前端：`npm run build`（`tsc -b && vite build` → `ui-dist`）。
- Host sidecar：esbuild 打包 `host/src/main.js` → SEA blob → postject 注入 node.exe。
- 安装器：`cargo tauri build`（产出 MSI + NSIS）。
