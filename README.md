# Kimi Cowork Host MVP-0 (Local, Kimi-only)

这个项目是一个零外部依赖的 Node.js MVP-0 本地 PoC 主机服务（host），用于验证 Kimi 工作流前置能力：

- 文件树枚举（仅限 trusted root）
- 文本文件读取与上下文打包
- 文件操作预览 / 申请执行（write / rename / move，禁止 delete）
- 可控命令运行（默认关闭）
- 最小 HTTP API

当前产品基准是 `plan/kimi-cowork-latest-product-plan-v0.3.md`。

注意：这是纯本地 Kimi-only PoC host，不是正式 MVP-1 产品主线。正式方向见 `docs/merged-execution-baseline.md`、`docs/mvp-1-windows-c-cloud-architecture.md` 和 `docs/v0.3-implementation-status.md`：Windows C 客户端、Go Local Agent、Cloud Backend、Device Relay、Task Orchestrator、Kimi Gateway、Office Mode、Developer Mode 和长期 QPS scaling。

## 快速开始

```powershell
cd "C:\Users\Administrator\Desktop\kimi cowork"
npm test
npm run smoke:host
node apps/host/src/main.js
```

测试使用 Node 内置 test runner，不需要外部依赖。默认 `npm test` 使用 `--test-isolation=none`，因为当前 Windows sandbox 可能会让隔离测试子进程报 `spawn EPERM`。
`npm run smoke:host` 会启动本地 host API，验证文件树、文件读取、上下文打包、write / rename / move preview、审批 apply、目标已存在阻止和 JSONL 审计。

启动服务后会监听 `http://127.0.0.1:3001`。如果端口被占用，用 `PORT` 覆盖；trusted root 可用 `TRUSTED_ROOT` 覆盖。

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

Windows C/WebView2 客户端骨架位于 `apps/windows-client`。MSVC 已安装在 Visual Studio Community 2026 下，但普通 PowerShell 默认不会加载 `cl.exe`。请先进入 VS Developer PowerShell 环境再构建：

```powershell
& 'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\Launch-VsDevShell.ps1' -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
cmake -S apps/windows-client -B build/windows-client-vs -G Ninja
cmake --build build/windows-client-vs --config Debug
```

本机已验证该路径可生成 `build/windows-client-vs/KimiCowork.exe`。
如果当前机器的 Microsoft Defender ASR 规则 `01443614-CD74-433A-B99E-2ECDC07BFC25` 拦截本地新构建 exe，GUI 烟测会在启动阶段报“拒绝访问”。这属于系统策略阻止执行，不是 CMake 构建失败或应用崩溃；需要用户在 Defender 中显式放行该精确 exe 路径后才能完成窗口级自动化 smoke。

### Windows 客户端操作烟测

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke-windows-client.ps1
```

该脚本会创建一个本地测试工作区，构建并启动 `KimiCowork.exe --workspace <path>`，然后验证：

- 自动加载信任工作区并扫描本地文件。
- 生成计划按钮会更新产物区。
- 生成计划会展示一个最小安全文件移动 preview。
- 审批执行按钮会写入 `.KimiCowork/artifacts/*.md`、`.KimiCowork/audit/audit.jsonl` 和 `.KimiCowork/rollback/*.jsonl`，并把预览文件移动到 `Kimi_Cowork整理/<模板名>/`。
- Developer Mode 按钮会打开模型/能力边界面板。
