(function () {
  function renderRunEventPayload(type, payload, appendLine) {
    const { progressStateFromIcon } = window.KimiCoworkUtils;
    if (type === "progress") {
      appendLine(progressStateFromIcon(payload.icon), payload.text || "处理中", payload.meta);
      return true;
    }
    if (type === "preview") {
      appendLine("done", `生成 ${payload.count ?? (payload.operations || []).length} 个可审批操作`);
      return true;
    }
    if (type === "awaiting_approval") {
      appendLine("running", "等待审批，审批前不会写入本机");
      return true;
    }
    if (type === "sources") {
      const names = (payload.items || [])
        .map((item) => item.relativePath || item.path || "")
        .filter(Boolean)
        .join("、");
      if (names) {
        appendLine("done", `来源 (${(payload.items || []).length})`, names.slice(0, 120));
        return true;
      }
      return false;
    }
    if (type === "assistant_end") {
      appendLine(
        payload.status === "failed" ? "failed" : "done",
        payload.status === "failed" ? "运行失败" : "运行完成",
        payload.durationMs != null ? `${payload.durationMs}ms` : "",
      );
      return true;
    }
    return false;
  }

  // Resolve an auth token if the host shipped one into this page. The legacy
  // browser UI predates auth, so this is best-effort: with auth ON the call may
  // still 401, in which case we fail once and degrade (no infinite retry).
  function resolveAuthToken() {
    try {
      return (
        window.KimiCoworkApi?.authToken ||
        window.__KCW_TOKEN__ ||
        (window.localStorage && window.localStorage.getItem("kcw_token")) ||
        null
      );
    } catch {
      return null;
    }
  }

  // SSE over fetch (not EventSource): EventSource cannot send an Authorization
  // header, so under the auth gate it 401s and retries forever. fetch lets us
  // attach the bearer token and abort cleanly. Returns a handle with close().
  function subscribeRunEvents(message, runId, options = {}) {
    const state = options.state || window.kimiCowork;
    const scrollConversationToEnd = options.scrollConversationToEnd || window.scrollConversationToEnd || function () {};
    if (!runId || typeof fetch === "undefined" || !message?.body) {
      return null;
    }
    const list = document.createElement("div");
    list.className = "message-progress message-progress-sse";
    message.body.append(list);

    const appendLine = (lineState, title, meta) => {
      const row = document.createElement("div");
      row.className = `progress-line is-${lineState || "wait"}`;
      row.textContent = meta ? `${title} · ${meta}` : title;
      list.append(row);
      scrollConversationToEnd();
    };

    const eventsPath = `/api/runs/${encodeURIComponent(runId)}/events`;
    const eventsUrl = window.KimiCoworkApi?.resolveUrl
      ? window.KimiCoworkApi.resolveUrl(eventsPath)
      : eventsPath;
    const controller = new AbortController();
    const seen = new Set();
    let closed = false;
    const handle = { close: () => { closed = true; try { controller.abort(); } catch { /* ignore */ } if (state.activeEventSource === handle) state.activeEventSource = null; } };
    state.activeEventSource = handle;

    const dispatch = (type, payload) => {
      const seq = payload?.seq;
      if (seq != null) {
        if (seen.has(seq)) return;
        seen.add(seq);
      }
      renderRunEventPayload(type, payload, appendLine);
      if (type === "assistant_end") {
        handle.close();
        if (typeof options.onComplete === "function") options.onComplete(payload);
      }
    };

    (async () => {
      try {
        const token = resolveAuthToken();
        const headers = { accept: "text/event-stream" };
        if (token) headers.authorization = `Bearer ${token}`;
        const res = await fetch(eventsUrl, { headers, signal: controller.signal });
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        // Parse SSE frames: blocks separated by a blank line, each with optional
        // `event:` and one or more `data:` lines.
        for (;;) {
          const { value, done } = await reader.read();
          if (done || closed) break;
          buffer += decoder.decode(value, { stream: true });
          let sep;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let evType = "message";
            const dataLines = [];
            for (const raw of frame.split("\n")) {
              if (raw.startsWith("event:")) evType = raw.slice(6).trim();
              else if (raw.startsWith("data:")) dataLines.push(raw.slice(5).trim());
            }
            if (!dataLines.length) continue;
            let payload = {};
            try { payload = JSON.parse(dataLines.join("\n")); } catch { payload = {}; }
            dispatch(evType, payload);
          }
        }
      } catch (err) {
        if (!closed) {
          if (err && err.name !== "AbortError" && typeof options.onError === "function") options.onError();
        }
      } finally {
        handle.close();
      }
    })();

    return handle;
  }

  window.KimiCoworkRunEvents = Object.freeze({
    renderRunEventPayload,
    subscribeRunEvents,
  });
}());
