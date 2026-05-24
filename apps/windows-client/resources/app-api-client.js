(function () {
  // In a packaged Tauri build the webview origin is `tauri://localhost`, not
  // the Node host. API calls must therefore target the host's absolute URL.
  // In dev the webview is served from this same origin, so the prefix is a
  // harmless no-op. Static assets are loaded by the webview itself and never
  // pass through this client, so prefixing API routes here is safe in both.
  function defaultHostBase() {
    const loc = window.location;
    if ((loc.protocol === "http:" || loc.protocol === "https:") && loc.port !== "5173") {
      return loc.origin;
    }
    return "http://127.0.0.1:3017";
  }

  const HOST_BASE = window.__KCW_HOST_BASE__ || defaultHostBase();

  function resolveUrl(route) {
    if (/^https?:\/\//i.test(route)) {
      return route;
    }
    return `${HOST_BASE}${route.startsWith("/") ? "" : "/"}${route}`;
  }

  function tauri() {
    return typeof window !== "undefined" ? window.__TAURI__ : undefined;
  }

  // True when running inside the Tauri desktop shell (vs. a plain browser/dev).
  function isDesktop() {
    return Boolean(tauri()?.core?.invoke);
  }

  async function invoke(command, args) {
    const core = tauri()?.core;
    if (!core?.invoke) {
      throw new Error(`Tauri command "${command}" is unavailable outside the desktop shell`);
    }
    return core.invoke(command, args);
  }

  async function probeHealth() {
    try {
      const response = await fetch(resolveUrl("/health"));
      return response.ok;
    } catch {
      return false;
    }
  }

  // Ensure the local host is reachable before the UI talks to it.
  // - Desktop: ask the Rust shell to start the bundled host sidecar, then poll
  //   /health until ready (bounded retries).
  // - Browser/dev: the host is started externally; this resolves on first OK
  //   probe (so it adds no latency when the host is already up).
  async function ensureHost({ attempts = 40, intervalMs = 250 } = {}) {
    if (isDesktop()) {
      try {
        await invoke("start_node_host");
      } catch {
        // Starting while already running is a no-op on the Rust side; a real
        // failure surfaces through the health probe loop below.
      }
    }
    for (let i = 0; i < attempts; i += 1) {
      if (await probeHealth()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  // Kick off host readiness as soon as this module loads. The promise is
  // awaited by every API call, so `app.js` needs no boot changes: the first
  // `getJson('/api/workspace')` transparently waits for the host to be up.
  const hostReady = ensureHost().catch(() => false);

  async function parseJsonResponse(response, route) {
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.error || `${route} returned ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function getJson(route) {
    await hostReady;
    const response = await fetch(resolveUrl(route));
    return parseJsonResponse(response, route);
  }

  async function postJson(route, body) {
    await hostReady;
    const headers = { "content-type": "application/json" };
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

  // Open a path with the OS default handler. Uses the Rust `open_path` command
  // (trusted-root enforced) on desktop; resolves false elsewhere.
  async function openPath(path) {
    if (isDesktop()) {
      return invoke("open_path", { path });
    }
    return false;
  }

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
