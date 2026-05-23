# Kimi Cowork 迭代优化计划 — 持续贴合 Claude Cowork

> 日期: 2026-05-22
> 形态已定: **桌面端 (Tauri 2)** + Node host sidecar + API 接入 (非 CLI)。不做网页端。
> 原则: 每个迭代交付一个"用户能感知 / 架构能复用"的 Claude Cowork 对位能力; 代码整洁、可扩展、可维护; 高风险执行进沙箱。

---

## 0. 当前已对齐 (截至本计划)

- 对话流 UX: 气泡 / 进度行 / 操作预览 / 内嵌审批 / 产物卡 / 来源页脚 / 澄清气泡。
- Composer `/模板` `@文件` `#历史` popover。
- 真 SSE 事件流 (RunEventBus + Last-Event-ID + 重放) + 前端 EventSource。
- 持久化: Memory / Runs 索引 / Scheduled Tasks, 文件 + SQLite 双后端 (Repository 形态)。
- 关键写接口 Idempotency-Key; audit 走 EventBus; trace/tenant/user 贯穿。
- 桌面壳: Tauri 模块化 Rust (error/config/security/sidecar/commands), 退出清理 sidecar, host 自举闭环。

## 1. 还差什么 (对位 Claude Cowork)

| 能力 | Claude Cowork | Kimi 现状 | 迭代 |
|---|---|---|---|
| 安全工具/代码执行 | Linux sandbox VM (网络白名单, 工作区挂载) | command-runner 默认关闭, 无隔离 | **迭代 A (本轮)** |
| 工具生态 / MCP | 完整 MCP host + 连接器 | 0 | 迭代 D |
| Skills 数量 | 60+ | 8 模板 | 迭代 C |
| React 组件化前端 | — | 静态 HTML/JS (manifest 已列 9 组件) | 迭代 B |
| 内联可视化 (Chart/Mermaid) | show_widget | 无 | 迭代 E |
| 持久 HTML Artifact (活页) | create_artifact | 产物是死文件 | 迭代 E |
| 子 Agent / Plan mode 产品化 | Agent 工具 | 状态机有, 无前台 | 迭代 D |

---

## 2. 迭代路线 (按 ROI + 依赖排序)

### 迭代 A — VM 沙箱执行 (本轮开始)
让 Kimi Cowork 能"安全地跑工具/代码", 对位 Claude Cowork 的 Linux sandbox。
- 结构化执行规格 (SandboxSpec): 不传裸 shell, 而是 `{ tool, args[], cwd(jail 在 trusted root), timeoutMs, env 白名单, network:false }`。
- Sandbox Port + 两个 adapter:
  - `LocalSubprocessSandbox` (本轮): 无 shell、arg 数组、cwd 限定、超时、输出上限、env 清洗、审计。
  - `VmSandbox` (契约 + stub): WSL2 / Docker / Hyper-V 适配目标, 网络默认关、工作区只读/读写挂载。
- `/api/sandbox/exec`: 默认审批 + Idempotency, 默认无网络, 进 runs 索引 + 发事件。
- 单测 + 集成测试。

### 迭代 B — 前端 React 组件化
按 `component-manifest.json` 的 9 个组件契约重写, 退役 59KB 单体 app.js。
- Vite + React + TS, 产物仍输出到 `resources/` 供 Tauri `frontendDist`。
- 所有网络收口到 `KimiCoworkApi` (已就位), 不再裸 fetch。
- 收益: 彻底解决"中文大文件截断"痛点 (组件文件小、可测、可维护)。

### 迭代 C — Skill / Recipe 注册表深化
- recipe → skill manifest (名称/触发/权限/产物类型), 前端可启停。
- 让模板能调用迭代 A 的沙箱 (例如"跑这段 Python 清洗数据")。

### 迭代 D — MCP 客户端 + 子 Agent
- Host 内置 MCP client, 先接 2-3 个本地化连接器。
- 工具懒加载 (对位 ToolSearch)。
- Plan mode 产品化 (先方案后执行的前台)。

### 迭代 E — 内联可视化 + 活页 Artifact
- 产物可生成可重开、自动刷新的 HTML 视图 (对位 create_artifact)。
- Chart/Mermaid 内联渲染 (对位 show_widget)。

---

## 3. 贯穿性工程纪律

- **单写者 + 逐文件 `node --check`**: 中文密集文件 (app.js/index.html) 改动必须整文件重写并立即校验, 严防多字节截断。
- **Ports & Adapters**: 新能力先定接口再写 adapter, 本地实现可换 VM/云实现不动调用方。
- **每个迭代**: 加测试 → `node --test` 全绿 → 更新 `docs/00-cowork-comparison-index.md` 状态矩阵。
- **安全默认**: 沙箱默认无网络、cwd jail、超时、输出上限、全审计; 高风险动作先审批。

---

## 4. 本轮 (迭代 A) 验收标准

- `apps/host/src/sandbox/` 提供 SandboxSpec 校验 + Sandbox Port + LocalSubprocessSandbox + VmSandbox 契约。
- `/api/sandbox/exec` 端点: 结构化规格、trusted-root jail、超时、输出上限、默认无网络、审计、入 runs 索引。
- 单测覆盖: 规格校验 (拒绝 shell 元字符 / 路径逃逸 / 缺超时)、本地执行 (stdout/退出码/超时/输出截断)、租户隔离。
- `node --test` 全绿。

---

## 迭代 B 进展 (2026-05-22): React + Vite + TS 脚手架已交付

非破坏性: 新建 `apps/windows-client/ui/`, 构建输出到 `ui-dist/`, 旧 `resources/` 不动 (验证后再切 tauri.conf)。仓库根 + Node host 仍零依赖, npm 依赖只在 ui/ 子项目。

已落地 (19 文件):
- 工程: `package.json`(React18+Vite5+TS5) / `vite.config.ts`(outDir ../ui-dist) / `tsconfig(.node).json` / `index.html` / `README.md`(构建+切换说明)。
- `src/lib/types.ts`(run/event/operation 类型) + `src/lib/api.ts`(类型化 host 客户端: HOST_BASE 绝对地址 / `ensureHost` 桌面自举 / `getJson`/`postJson` / `subscribeRunEvents` SSE / `openPath` / 幂等 key, 镜像 legacy app-api-client 契约)。
- `src/components/` 9 个 manifest 组件 (TSX, prop 驱动): MessageBubble / ClarificationCard / ProgressLine / PreviewCard / ApprovalActions / ArtifactCard / SourcesFooter / Composer(/ @ # popover + 键盘导航) / TaskStatusBadge。
- `src/App.tsx` 组合: 对话流 + Composer + 发送→recipe run→SSE 事件流→预览/审批/来源/产物, 审批走 /api/file-ops/apply。
- `src/main.tsx` + `src/styles.css`(浅色 + 珊瑚红, 对齐 app.css)。

验证 (此 VM 无 npm/tsc): 跨文件导入/导出一致性通过、所有 ts/tsx 括号平衡、JSON 配置合法、host `node --test` 仍 136/136。

激活步骤 (在能构建的机器):
```
cd apps/windows-client/ui && npm install && npm run build   # -> ../ui-dist
# 然后改 src-tauri/tauri.conf.json: frontendDist -> ../ui-dist, devUrl -> http://127.0.0.1:5173
```
