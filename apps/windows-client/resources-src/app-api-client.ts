(function () {
  // 安装版 Tauri webview 的 origin 是 `tauri://localhost`,并不是 Node host。
  // 因此所有 API 请求都必须转成 host 的绝对地址;开发态如果已经同源,该前缀仍是
  // 无害兜底。静态资源由 webview 自己加载,不会经过这个 API client。
  function defaultHostBase() {
    const loc = window.location;
    if ((loc.protocol === "http:" || loc.protocol === "https:") && loc.port !== "5173") {
      return loc.origin;
    }
    return "http://127.0.0.1:3017";
  }

  const HOST_BASE = window.__KCW_HOST_BASE__ || defaultHostBase();

  // 允许调用方传绝对 URL 或 `/api/*` 相对路由,统一在边界层完成 host 地址拼接。
  function resolveUrl(route: any) {
    if (/^https?:\/\//i.test(route)) {
      return route;
    }
    return `${HOST_BASE}${route.startsWith("/") ? "" : "/"}${route}`;
  }

  // Tauri bridge 只在桌面壳内存在;普通浏览器调试时必须安全返回 undefined。
  function tauri() {
    return typeof window !== "undefined" ? window.__TAURI__ : undefined;
  }

  // 判断当前是否运行在桌面壳内,用于区分可用的原生命令能力。
  function isDesktop() {
    return Boolean(tauri()?.core?.invoke);
  }

  // 所有 Tauri 命令都从这里进入,确保非桌面环境给出可读错误而不是静默失败。
  async function invoke(command: any, args: any = undefined) {
    const core = tauri()?.core;
    if (!core?.invoke) {
      throw new Error(`Tauri command "${command}" is unavailable outside the desktop shell`);
    }
    return core.invoke(command, args);
  }

  // 健康检查只关心 host 是否可达;异常统一折叠为 false,交给轮询流程处理。
  async function probeHealth() {
    try {
      const response = await fetch(resolveUrl("/health"));
      return response.ok;
    } catch {
      return false;
    }
  }

  // 在 UI 访问 host 前确认本地 host 已就绪。
  // - 桌面态:先请求 Rust 壳拉起内置 host sidecar,再有限轮询 /health。
  // - 浏览器/开发态:host 由外部启动,这里仅等待首次健康检查通过。
  async function ensureHost({ attempts = 40, intervalMs = 250 }: any = {}) {
    if (isDesktop()) {
      try {
        await invoke("start_node_host");
      } catch {
        // Rust 侧已运行时重复 start 是幂等操作;真实失败会在后续健康检查暴露。
      }
    }
    for (let i = 0; i < attempts; i += 1) {
      if (await probeHealth()) {
        return true;
      }
      await new Promise((resolve: any) => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  // 模块加载时立即启动 host 就绪检查。每个 API 调用都会等待该 promise,
  // 因此首个 `getJson('/api/workspace')` 会透明等待 host,不需要 app 入口额外改造。
  const hostReady = ensureHost().catch(() => false);

  // 统一解析 JSON 响应,保留 status/payload 供 UI 呈现可读错误。
  async function parseJsonResponse(response: any, route: any) {
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.error || `${route} returned ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  // GET/POST 是资源版 UI 唯一的 host HTTP 出口,调用方不直接拼 fetch 细节。
  async function getJson(route: any) {
    await hostReady;
    const response = await fetch(resolveUrl(route));
    return parseJsonResponse(response, route);
  }

  async function postJson(route: any, body: any) {
    await hostReady;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (body?.idempotencyKey) {
      headers["idempotency-key"] = body.idempotencyKey;
    }
    const response = await fetch(resolveUrl(route), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return parseJsonResponse(response, route);
  }

  // 使用系统默认程序打开路径。桌面态走 Rust `open_path`(trusted-root 校验在壳内执行),
  // 非桌面环境返回 false,避免浏览器调试态误触发本地副作用。
  async function openPath(path: any) {
    if (isDesktop()) {
      return invoke("open_path", { path });
    }
    return false;
  }

  // 冻结全局 API 面,防止后续资源脚本运行时改写边界函数。
  window.AgentCoworkApi = Object.freeze({
    HOST_BASE,
    resolveUrl,
    isDesktop,
    getJson,
    postJson,
    ensureHost,
    hostReady,
    openPath,
  });
}());
