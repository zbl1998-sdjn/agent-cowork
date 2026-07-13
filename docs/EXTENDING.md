# 扩展指南 (Extending Agent Cowork)

面向维护者：本项目的核心扩展点、契约与约定。目标是「加功能时只动一处、有清晰边界、有测试套路」。

## 架构总览

```
Tauri 2 桌面壳 (Rust)  ── frontendDist ──>  React UI (apps/windows-client/ui)
        │                                         │  fetch / SSE (CORS, loopback)
        │ externalBin sidecar                     ▼
        └──────────────>  Node host (apps/host)  ──>  OpenAI 兼容模型 API
                          组合根: src/server.ts
```

- **Host（`apps/host`）**：Node ESM 服务，组合根 `src/server.ts` 负责装配存储、鉴权、并发限流、路由分发与优雅停机。根 manifest 当前包含运行时依赖 `zod` 与 `pg`，不要再按“零运行时依赖”设计。
- **UI（`apps/windows-client/ui`）**：React 18 + Vite + TS。`src/lib/api.ts` 是对 `src/lib/api/*` 的兼容聚合出口，HTTP 细节保持在该传输层内。
- **打包**：host 经 TypeScript 编译、esbuild bundling 和 Node SEA 生成 sidecar；UI 经 `tsc -b && vite build` 出 `ui-dist`；当前 Tauri manifest 的 bundle target 只有 NSIS。

## 扩展点 1：存储适配器 (Store Adapters)

持久化采用「同一接口、多后端」的 Ports & Adapters 模式，现有后端包括 file、SQLite 和 PostgreSQL。新增数据类型时先定义接口，再按实际支持范围补齐适配器，并明确哪个后端属于桌面默认与哪个仍需外部集成验收。

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
- **postgres 适配器**：`pg` 是根 manifest 中锁定的运行时依赖，构建时进入 SEA bundle；适配器仍用动态 `import()` 延迟初始化，并允许注入 `{ pool }` 做契约测试。
- **选用**：组装层按 `storeBackend` / `KCW_STORE` 选择后端，并允许配置注入测试替身。
- **迁移**：schema 变更必须新增连续编号的 `src/storage/migrations-postgres/NNNN_*.sql`，不能只改 `0001_init.sql`。`npm run postgres:migrations:plan` 会离线校验编号连续性并输出文件 SHA-256；该命令明确不读取 `DATABASE_URL`、不连接数据库，也不代替人工审批后的外部迁移执行。

参考实现：`storage/conversation-store.ts`（file）+ `storage/postgres-conversation-store.ts`（PG）。

## 扩展点 2：HTTP 路由 (Route Handlers)

每个路由模块导出一个 `handleXxxRoutes(args)`，**返回 `true` 表示已处理、`false` 表示放行给后续 handler**。在 `server.ts` 使用的路由链中按顺序注册。

```ts
export async function handleFooRoutes({ request, response, pathname, requestUrl, requestContext, trustedRootDefault, fooStore }) {
  if (request.method === 'GET' && pathname === '/api/foo') {
    sendJson(response, 200, { ... });
    return true;
  }
  return false;
}
```

约定：

- **顺序敏感**：鉴权/CORS/安全头在分发前统一处理（见 `server.ts` 请求入口）；handler 只管自己的路径。
- **受信根**：任何接收路径参数的端点必须经 `assertTrustedPath(resolved, trustedRootDefault)` 收敛到受信根内，防目录穿越。
- **请求体**：用 `withJsonBody(request, response, handler)`；它做 content-type 校验 + 1MB 体积上限（超限 413）+ JSON 解析错误（400）。
- **租户**：从 `requestContext.tenantId/userId` 取（已由入口根据 Bearer token 解析注入），不要自己解析 token。

## 扩展点 3：Agent 工具 (Tools)

Agent 循环在 `engine/agent-runner.ts`。工具集由 `engine/agent-tools.ts` 与 `engine/agent/toolset-builder.ts` 装配，模型通过 `ToolSearch` 懒加载按需注入，避免一次性灌入全部工具。新增工具：实现 `{ name, description, inputSchema, run }`，在工具注册表登记即可，无需改 agent 循环本身。

## 扩展点 4：鉴权与多租户

- **无状态 JWT**（`auth/jwt.ts`，HS256）跨实例可验；本地 session 由 `auth/user-store.ts` / `auth/sqlite-user-store.ts` 管理并带过期时间。
- 请求入口解析 `Authorization: Bearer`，把 `userId`/`tenantId` 写入 `requestContext`，所有下游据此隔离。
- 加新身份来源：实现一个 `resolveXxxIdentity(token)` 返回 `{ userId, tenantId }`，在入口的解析链里加一档。
- **主机级全局变更**：Kimi 默认配置、MCP registry、skill enabled、数据 purge/retention 只能在读取 body 或产生副作用前调用 `requireGlobalMutationAdmin`。权限只按入口生成的 `requestContext.tenantId + userId` 与 `HostConfig.globalMutationAdmins` / `KCW_GLOBAL_MUTATION_ADMINS` 精确匹配；禁止采信客户端自称的 role/header/query/body。

## 安全基线（改动时不要破坏）

- **安全响应头**：`http/middleware/common.ts` 对响应应用安全头与来源校验。
- **路径策略**：`security/path-policy.ts` 的 `assertTrustedPath` 拒绝受信根外与系统敏感目录（如 Temp/AppData）。
- **CORS**：`http/request-origin-policy.ts` 只放行产品/开发服务器的精确 Origin（`127.0.0.1:5173`、`localhost:5173` 与 Tauri origins）；不能把任意 loopback 端口视为可信。
- **密钥**：模型与连接器密钥不得回显或写日志；持久化必须复用现有凭据/落盘保护层，不能新增明文配置文件。
- **全局写授权**：新增任何跨用户共享的 host 状态 mutation，都要复用 `auth/global-mutation-admin.ts` 的 exact tuple 门禁并加 403-before-body、跨租户、同租户兄弟用户和无副作用测试；只按 userId 或客户端角色授权均不允许。
- **CSP**：见 `src-tauri/tauri.conf.json`；当前策略为 `object-src 'none'`、`frame-src 'self' data:`，新增预览能力不得自行放宽外壳策略。

## PostgreSQL 切换

设 `KCW_STORE=postgres` + `DATABASE_URL=...` 前，先运行 `npm run postgres:migrations:plan` 审阅清单和哈希，再由数据库管理员按文件名升序应用所有尚未执行的 `migrations-postgres/*.sql`。当前清单是 `0001` → `0002` → `0003` → `0004`；不得只应用 `0001`。

`0004_pending_approvals_user_scope.sql` 会把无可信 tenant/user 所有者的 legacy pending 审批失败关闭，并要求后续 pending 行具有非空 tenant/user。旧 host 不会写入完整用户作用域，因此这不是滚动兼容迁移：先停止接收新请求并排空/停止旧 host，完成数据库备份和迁移审批，再部署新 host；迁移后不要回滚到旧 host 二进制，数据库回退只能走已验证的迁移前快照。仓库没有自动 apply 路径，避免 host 启动时静默修改 schema。

host 随后会选择 PG 适配器与 LISTEN/NOTIFY 接线。仓库门禁当前以 mock pool / mock cluster 验证契约，没有启动真实 PostgreSQL 或双实例故障场景；上线前必须另做真实数据库迁移、跨实例、断连恢复与负载验收。

## 测试约定

- 后端：`node --test`，测试放 `apps/host/test/*.test.ts`。
- 工作区根用 `makeTestWorkspace(prefix)`（项目内非敏感目录）；**不要用系统 Temp**，会被 path-policy 拒。
- PG 适配器：注入 mock pool（见 `test/postgres-conversation-store.test.ts`）；真实 PG 验收单独记录。
- 前端：`vitest run`；类型 `tsc --noEmit`。
- 权威验证在真实 Windows 上执行（Linux 沙箱挂载偶发只读/读截断假象）。

## 构建与发布

- 前端：仓库根运行 `npm run build:ui`（UI 包内部为 `tsc -b && vite build` → `ui-dist`）。
- Host sidecar：`npm run build:host` 编译 `apps/host/src/main.ts`，经 esbuild → SEA blob → 锁文件安装的 postject 注入 `node.exe`；`pg` 必须随 bundle 可用。
- 安装器：在 `apps/windows-client/src-tauri` 构建 Tauri；当前 `tauri.conf.json` 只声明 NSIS target。构建成功不等于发布验收，仍需版本匹配的安装版 smoke、受信任签名与 updater 证据。
