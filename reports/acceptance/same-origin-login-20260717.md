# 验收证据:打包态同源加载修复 WebView2 150 登录阻断

- 日期:2026-07-17
- 构建:`Agent Cowork_0.5.0_x64-setup.exe`(NSIS,currentUser)
- 安装目录:`C:\Users\Administrator\AppData\Local\Agent Cowork`

## 背景

Chromium 150 的 Local Network Access(LNA)硬阻断 `tauri.localhost`(非本地地址空间)→ `127.0.0.1:3017`
回环的一切 fetch/SSE。实测确认以下旁路在 WebView2 150 上**全部失效**:

- `--disable-features=LocalNetworkAccessChecks,msWebViewAllowLocalNetworkAccessChecks`(即便进程确实带上该参数)
- host 预检回 `Access-Control-Allow-Private-Network: true`
- `useHttpsScheme`(`https://tauri.localhost`)

失败证据(旧版):`进入本地失败:Failed to fetch [from=http://tauri.localhost/ to=http://127.0.0.1:3017/api/auth/guest]`

## 修复:同源加载

1. `tauri.conf.json` 把 `../ui-dist` 打包为资源。
2. `sidecar.rs` 解析 `resource_dir()/ui-dist`,存在 `index.html` 时经 `ACW_UI_DIST_ROOT` 传给 host。
3. `host-state.ts` 的 `uiDistRoot` 优先读 `ACW_UI_DIST_ROOT`,host 在 `127.0.0.1:3017` 同源直出 SPA。
4. `main.tsx`/`transport.ts` 打包态先经 IPC 拉起并校验 host,再整页跳到 `http://127.0.0.1:3017`;
   同源托管态下 `isDesktop()` 返回 false,按同源 web 应用走 fetch/health(不再调必然被拒的 IPC)。

## 实测结果(安装版)

- host `/health` → 200(第 2 次探测,壳经 IPC 拉起)。
- host `GET /` → 200,1313 字节,含 `id="root"`(同源直出 React SPA index.html,不再 "Static asset not found")。
- 资源落地:`<install>\ui-dist\index.html` 存在(与 `<install>\python-embedded` 同级,`resource_dir()` = 安装根)。
- WebView 窗口:重定向后显示登录页(UIA 读到"登录 / 用户名 / 密码 / 跳过,先在本地使用 →")。
- UIA InvokePattern 点"跳过,先在本地使用 →":
  - 进入完整主界面(新建对话/任务中心/文件成果/自动任务/可视化编辑/小白办公首页/办公模板)。
  - **无** "Failed to fetch" / "进入本地失败" / 错误文案。
- 设置 →「云端模型」页同源渲染正常:
  - Line 2「Ollama 云(免配置 · 云端算力)」登录按钮 + 推荐 `-cloud` 模型(gpt-oss:20b/120b、qwen3.5:9b、deepseek-v4-flash、kimi-k2.7-code)。
  - Line 1「启用云端模型」知情开关(未启用:仅本地模型)。

截图:`scratchpad/same-origin-login-ok.png`(1381×898,PrintWindow 离屏)。

## 门禁

- `npm run check` → exit 0(filesize 729 文件通过;host-state 265、transport 277 登记基线)。
- `npm run test:ui` → 481 passed。
- host `ui-dist-serving.test.ts` → 3 passed。
- `cargo check` → 通过。
