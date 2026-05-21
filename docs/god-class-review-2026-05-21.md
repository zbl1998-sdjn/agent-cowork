# 2026-05-21 God-Class Review and First Split

本页记录“全面 review + 并行 agent + 拆分上帝类 + 静态/测试无错误”的第一批证据化结果。目标不是一次性大改, 而是在保持 `node --test` / smoke 全绿的前提下, 逐批把上帝文件拆成可测试边界。

## 当前最大文件

| 文件 | 本轮前 | 本轮后 | 说明 |
|---|---:|---:|---|
| `apps/windows-client/resources/app.js` | 2054 行 | 1966 行 | 仍是最大前端编排文件, 已抽出纯工具函数、API client 和 SSE/run event 渲染 |
| `apps/host/src/server.js` | 961 行 | 592 行 | 已抽出 HTTP/request helpers、task presenter、memory/run/schedule routes |
| `apps/windows-client/resources/app.css` | 1777 行 | 1777 行 | 后续需要按 layout/components 分层 |
| `services/kimi-gateway/internal/kimi/client.go` | 647 行 | 647 行 | 后续可按 request/stream/tools/vision/fallback 拆 |

## 并行审查结论

### 前端 `app.js`

审查 agent 结论: `app.js` 是 classic script 上帝文件, 同时承担全局状态、DOM refs、视图切换、API client、Composer popover、消息流、SSE、历史 run、上传、计划生成、审批执行和启动绑定。

第一批低风险拆分边界:

- `app-utils.js`: 纯工具函数, 无 DOM/state 写入。
- `app-api-client.js`: 后续抽 `postJson` 和 API 薄封装。
- `app-composer-popover.js`: 后续抽 composer popover controller, 由 `app.js` 注入 DOM/state/callback。
- `app-run-events.js`: 后续抽 SSE/replay 事件渲染, 由 `app.js` 管理 `state.activeEventSource`。

本轮已抽 `app-utils.js`、`app-api-client.js`、`app-run-events.js`, 避免一次跨越 `generatePlan()` / `runRecipePlan()` / `approvePlan()` 这些高耦合编排点。

### 后端 `server.js`

审查 agent 结论: `server.js` 主要混合了 HTTP 基础设施、安全边界、Kimi run 持久化、memory routes、runs/SSE routes、workspace/file/recipe/file-ops routes、schedule routes。

第一批低风险拆分边界:

- `http/request-utils.js`: JSON response/body、headers、Origin guard、request context、body fingerprint。
- `runtime/task-presenter.js`: run record 到 `/api/tasks` card 的 presenter。
- `routes/memory-routes.js`: memory 读写路由。
- `routes/run-routes.js`: `/api/tasks`、runs index、run detail、SSE event stream。
- `routes/schedule-routes.js`: schedules CRUD、手动 tick、schedule mutation 幂等与租户归属。

本轮保持 public `createServer(config)` 不变, route 顺序和安全边界由集成测试约束。

## 本轮已落地

- 新增 `apps/host/src/http/request-utils.js`。
- 新增 `apps/host/src/runtime/task-presenter.js`。
- 新增 `apps/host/src/routes/memory-routes.js`。
- 新增 `apps/host/src/routes/run-routes.js`。
- 新增 `apps/host/src/routes/schedule-routes.js`。
- 新增 `apps/windows-client/resources/app-utils.js`。
- 新增 `apps/windows-client/resources/app-api-client.js`。
- 新增 `apps/windows-client/resources/app-run-events.js`。
- `index.html` 改为先加载 `app-utils.js`、`app-api-client.js`、`app-run-events.js`, 再加载 `app.js`, 保持 classic script, 不用 `type=module`。
- Host 静态白名单新增 `/app-utils.js`、`/app-api-client.js`、`/app-run-events.js`。
- `scripts/smoke-ui-contract.mjs` 改为解析 `index.html` 中所有 script, 逐个 GET 并拼接检查契约, 防止拆文件后 smoke 误报或漏报。
- `apps/host/test/server.test.js` 覆盖新增静态 JS 资源。
- 修复 `readJsonBody` 只按 UTF-16 字符数判断限制的问题, 改为按 UTF-8 byte length 累计。
- 修复 schedule cancel/delete/_tick 缺 `Idempotency-Key` 与跨租户归属校验的问题; 手动 tick 只触发当前 tenant due schedules。
- `GET /api/runs/:id` 非法 id 现在返回 400, 与 SSE route 对齐。

## 后续优先拆分

1. `app-composer-popover.js`: 抽 composer popover controller, 保持 slash/at/hash 触发契约。
2. `app-plan-flow.js`: 抽 `generatePlan()` / `runRecipePlan()` / approval 编排, 需要先补更细前端 smoke。
3. `routes/workspace-file-routes.js`: 从 `server.js` 抽 files/tree/read/extract/search/upload/context-bundle。
4. `app.css`: 按 base/layout/components 分文件, 同步更新 Host 静态白名单和 smoke。
5. `services/kimi-gateway/internal/kimi/client.go`: 按 request/stream/tools/vision/fallback 拆 Go client。

## 验证命令

- `node --check apps/windows-client/resources/app-utils.js`
- `node --check apps/windows-client/resources/app.js`
- `node --check apps/host/src/server.js`
- `node --check apps/host/src/http/request-utils.js`
- `node --check apps/host/src/routes/*.js`
- `node --test --test-isolation=none`
- `npm run smoke:ui`
- `npm run smoke:host`
- `npm run smoke:tauri-scaffold`
- `go test ./...` in `services/kimi-gateway`

备注: 当前机器缺 `cargo` / `rustc` / `cargo tauri`, 所以 Tauri smoke 只能验证 scaffold contract, 不能验证真实 dev window / installer。
