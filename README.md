# Kimi Cowork Host MVP-0 (Local, Kimi-only)

这个项目是一个零外部依赖的 Node.js MVP-0 本地 PoC 主机服务（host），用于验证 Kimi 工作流前置能力：

- 文件树枚举（仅限 trusted root）
- 文本文件读取与上下文打包
- 文件操作预览 / 申请执行（write / rename / move，禁止 delete）
- 可控命令运行（默认关闭）
- Kimi CLI 计划运行记录（`.KimiCowork/runs/*.json`）
- 最小 HTTP API

当前产品基准是 `plan/kimi-cowork-latest-product-plan-v0.3.md`。

注意：这是纯本地 Kimi-only PoC host，不是正式 MVP-1 产品主线。正式方向见 `docs/merged-execution-baseline.md`、`docs/mvp-1-windows-c-cloud-architecture.md` 和 `docs/v0.3-implementation-status.md`：Windows C 客户端、Go Local Agent、Cloud Backend、Device Relay、Task Orchestrator、Kimi Gateway、Office Mode、Developer Mode 和长期 QPS scaling。

## 快速开始

```powershell
cd "C:\Users\Administrator\Desktop\kimi cowork"
npm run demo:mvp
```

`npm run demo:mvp` 是当前 Web/Host MVP 的一键演示验收入口：如果没有健康的 MVP 运行态，它会在后台启动 `start:mvp` 并打开页面；随后运行 live 操作测试、默认验证、Windows readiness 只读检查和总审计，最后写出 `build/mvp-demo-report.json`。

手动拆分执行时，建议按这个顺序：

```powershell
npm run start:mvp
npm run smoke:live-mvp
npm test
npm run verify:mvp
npm run verify:windows-readiness
npm run audit:mvp
npm run smoke:rendered-ui
npm run smoke:windows-resources
npm run smoke:kimi-cli
npm run smoke:mvp-runtime
npm run smoke:ui
npm run smoke:host
```

测试使用 Node 内置 test runner，不需要外部依赖。默认 `npm test` 使用 `--test-isolation=none`，因为当前 Windows sandbox 可能会让隔离测试子进程报 `spawn EPERM`。
`npm run smoke:ui` 会验证前端入口、关键 UI 控件、前端脚本使用的 Host API 路由，以及和页面一致的 workspace / tree / read / preview / apply / audit 操作链。
`npm run smoke:rendered-ui` 会用本机 Edge/Chrome 的 DevTools 协议启动临时 headless 浏览器，真实打开 Kimi Cowork、检查 1536x900 和 1366x768 布局、点击发送和审批，并确认 artifact / audit 已落盘；报告和截图写入 `build/rendered-ui-smoke-report.json` 与 `build/rendered-ui-smoke-1536x900.png`。
`npm run smoke:live-mvp` 会读取当前 `build/mvp-runtime.json`，直接打开正在运行的 MVP URL，完成发送/审批，并确认当前 runtime workspace 里新增 artifact 且 audit 增长；报告和截图写入 `build/live-mvp-smoke-report.json` 与 `build/live-mvp-smoke-1536x900.png`。
`npm run smoke:windows-resources` 会用 headless Edge/Chrome 通过 `file://` 直接加载 Windows C 客户端资源，验证截图风格、1366x768 边界和静态预览/审批交互；它不会启动 `KimiCowork.exe`，因此可在 Defender ASR 阻塞 exe 时继续提供资源级验收。
`npm run smoke:kimi-cli` 会启动一个临时 Host API，真实调用本机 Kimi CLI 的 `--print --final-message-only` 模式，验证 `/api/kimi/plan` 可以基于 Host 提供的本地摘要生成中文计划，并落盘 `.KimiCowork/runs/*.json` 运行记录。该 smoke 依赖本机已登录 Kimi CLI 和可用网络，不放进默认 `verify:mvp` 的运行项。
`npm run smoke:mvp-runtime` 会启动一个临时 MVP 服务、检查健康状态和 runtime 文件、调用 `status:mvp`、调用 `stop:mvp`，确认本地产品入口可被明确启动和关闭；报告写入 `build/mvp-runtime-smoke-report.json`。
`npm run smoke:host` 会启动本地 host API，验证前端入口、默认工作区 API、文件树、文件读取、上下文打包、write / rename / move preview、审批 apply、目标已存在阻止和 JSONL 审计。
`npm run verify:mvp` 会聚合语法检查、Node 单测、Host 操作 smoke、MVP runtime smoke、UI contract smoke 和 rendered browser smoke，并把可审计报告写到 `build/mvp-verification-report.json`。如果已经在 Defender/企业 ASR 策略中放行 Windows 客户端精确 exe 路径，可以运行 `node scripts/verify-mvp.mjs --windows-client` 把原生窗口级 smoke 纳入 `build/mvp-verification-report-windows.json`。
`npm run audit:mvp` 会读取当前 runtime、verification、rendered UI、live MVP、runtime smoke、Windows 资源 smoke 和 Windows readiness 证据，汇总到 `build/mvp-acceptance-audit.json`；默认会在 Web/Host MVP 已就绪但原生窗口 smoke 被 Defender ASR 阻塞时正常生成报告，`npm run audit:mvp -- --strict` 会把任何未完成的完整目标作为非零退出。
`npm run verify:windows-readiness` 是只读检查：它不会修改 Defender，只会检查 `KimiCowork.exe` 是否存在、是否已有精确 ASR-only 路径排除项、普通目录级 exclusion 是否仍被 ASR 绕过、最近是否有 ASR 阻断事件，并写出 `build/windows-client-readiness.json`。
`npm run start:mvp` 会创建 `build/mvp-workspace` 演示工作区，启动本地服务并打开 Kimi Cowork UI。
`npm run status:mvp` 会读取 `build/mvp-runtime.json` 并检查 PID 与 `/health`；`npm run stop:mvp` 会根据 runtime 文件停止由 `start:mvp` 启动的服务。

启动服务后会监听 `http://127.0.0.1:3001`，并直接服务 Kimi Cowork 前端工作台。页面会调用同源 Host API 读取 trusted root、列出本地文件、生成写入型操作预览，并在审批后写入 `.KimiCowork/artifacts/`。如果端口被占用，用 `PORT` 覆盖；trusted root 可用 `TRUSTED_ROOT` 覆盖。

Kimi CLI 计划生成功能默认关闭，避免普通 MVP 验证依赖真实账号/网络。要让前端“发送”时优先调用本机 Kimi CLI：

```powershell
$env:ENABLE_KIMI_CLI_PLAN = "1"
$env:KIMI_CLI = "C:\Users\Administrator\.local\bin\kimi.exe"
npm run start:mvp
```

后端接口是 `POST /api/kimi/plan`，只接受 trusted root 内的工作区，并使用 `--print --final-message-only` 生成文本计划；每次调用都会生成 `runId`、`runPath` 并写入 `.KimiCowork/runs/`，前端会显示最近一次运行记录。审批执行仍走本地 `file-ops/apply`。

运行记录查询接口：

- `GET /api/runs`：列出最近的 Kimi 计划运行。
- `GET /api/runs/<runId>`：读取单次运行详情，包含输入摘要、状态、耗时、结果或错误。

```powershell
$env:PORT = "3011"
$env:TRUSTED_ROOT = "C:\Users\Administrator\Desktop\kimi cowork"
npm start
```

## MVP-1 骨架验证

```powershell
go test ./...
```

分别从这些目录运行：

- `apps/local-agent`
- `services/api`
- `services/relay`
- `services/orchestrator`
- `services/kimi-gateway`

Kimi Gateway 已实现 OpenAI-compatible 非流式 chat client，默认走 `POST /chat/completions`，支持 bearer token、请求校验、超时、429/5xx 有界重试和响应解析。真实联网调用应由部署环境传入 Kimi/Moonshot-compatible `baseURL` 和 API key；仓库测试使用 `httptest`，不需要公网或真实密钥。

Local Agent CLI 已经可直接提供本地文件能力：

```powershell
cd "C:\Users\Administrator\Desktop\kimi cowork\apps\local-agent"
go run .\cmd\kimi-cowork-agent health
go run .\cmd\kimi-cowork-agent list --root "C:\path\to\workspace"
go run .\cmd\kimi-cowork-agent read --root "C:\path\to\workspace" --path "C:\path\to\workspace\notes.md"
go run .\cmd\kimi-cowork-agent apply --root "C:\path\to\workspace" --ops "C:\path\to\ops.json" --journal "C:\path\to\workspace\.KimiCowork\audit\agent.jsonl" --batch demo
```

显式 CLI 操作 smoke：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke-local-agent.ps1
```

当前机器的 Defender ASR 也会拦截 Go 生成的临时测试 exe，规则同样是 `01443614-CD74-433A-B99E-2ECDC07BFC25`。因此该 smoke 在未放行前会报 `Access is denied`；带标签测试源码已编译通过，默认 `go test ./...` 不依赖该显式 smoke。

Windows C/WebView2 客户端骨架位于 `apps/windows-client`。MSVC 已安装在 Visual Studio Community 2026 下，但普通 PowerShell 默认不会加载 `cl.exe`。请先进入 VS Developer PowerShell 环境再构建：

```powershell
& 'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\Launch-VsDevShell.ps1' -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
cmake -S apps/windows-client -B build/windows-client-vs -G Ninja
cmake --build build/windows-client-vs --config Debug
```

本机已验证该路径可生成 `build/windows-client-vs/KimiCowork.exe`。
如果当前机器的 Microsoft Defender ASR 规则 `01443614-CD74-433A-B99E-2ECDC07BFC25` 拦截本地新构建 exe，GUI 烟测会在启动阶段报“拒绝访问”。这属于系统策略阻止执行，不是 CMake 构建失败或应用崩溃；需要用户在 Defender 中显式放行该精确 exe 路径后才能完成窗口级自动化 smoke。
`scripts\smoke-windows-client.ps1` 会在启动被拦截时读取最近的 Defender ASR 事件，并输出被拦截路径、规则 ID 和重跑命令，便于精确放行后复测。`npm run verify:windows-readiness` 是只读诊断入口；它会同时列出普通 `ExclusionPath`、ASR-only exclusion、是否缺少精确 ASR-only exe exclusion、建议授权文字和放行后复测命令。当前机器已经有项目目录级 `ExclusionPath`，但 ASR 事件仍然命中 `KimiCowork.exe`，因此 readiness 检查以 `AttackSurfaceReductionOnlyExclusions` 的精确 exe 路径作为窗口级 smoke 的放行证据。

当前完整目标的最后一步需要原生窗口级 smoke。只有在你明确接受这个安全权衡后，才应添加精确路径排除项：

```powershell
Add-MpPreference -AttackSurfaceReductionOnlyExclusions "C:\Users\Administrator\Desktop\kimi cowork\build\windows-client-vs\KimiCowork.exe"
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke-windows-client.ps1
node .\scripts\verify-mvp.mjs --windows-client
npm run audit:mvp -- --strict
```

推荐的明确授权文字是：

```text
同意为 C:\Users\Administrator\Desktop\kimi cowork\build\windows-client-vs\KimiCowork.exe 添加 Microsoft Defender ASR-only 精确路径排除项
```

### Windows 客户端操作烟测

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke-windows-client.ps1
```

该脚本会创建一个本地测试工作区，构建并启动 `KimiCowork.exe --workspace <path>`，然后验证：

- 自动加载信任工作区并扫描本地文件。
- 生成计划按钮会更新产物区，并读取信任工作区内 TXT / Markdown / CSV 的本地内容摘要。
- 生成计划会展示一个最小安全文件移动 preview。
- 审批执行按钮会写入 `.KimiCowork/artifacts/*.md`、`.KimiCowork/audit/audit.jsonl` 和 `.KimiCowork/rollback/*.jsonl`，并把预览文件移动到 `Kimi_Cowork整理/<模板名>/`。
- Developer Mode 按钮会打开模型/能力边界面板。
