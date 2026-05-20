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
node apps/host/src/main.js
```

测试使用 Node 内置 test runner，不需要外部依赖。默认 `npm test` 使用 `--test-isolation=none`，因为当前 Windows sandbox 可能会让隔离测试子进程报 `spawn EPERM`。

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

Windows C/WebView2 客户端骨架位于 `apps/windows-client`。当前机器 PATH 上未发现 `cl`、`gcc` 或 `clang`，所以 CMake 配置文件已提供，但本轮未把 C 客户端构建作为必过验证。
