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

  function subscribeRunEvents(message, runId, options = {}) {
    const state = options.state || window.kimiCowork;
    const scrollConversationToEnd = options.scrollConversationToEnd || window.scrollConversationToEnd || function () {};
    if (!runId || typeof EventSource === "undefined" || !message?.body) {
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

    let source;
    try {
      source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
    } catch {
      list.remove();
      return null;
    }
    state.activeEventSource = source;
    const seen = new Set();
    const close = () => {
      try {
        source.close();
      } catch {
        // ignore
      }
      if (state.activeEventSource === source) {
        state.activeEventSource = null;
      }
    };

    const handle = (type, payload) => {
      const seq = payload?.seq;
      if (seq != null) {
        if (seen.has(seq)) return;
        seen.add(seq);
      }
      renderRunEventPayload(type, payload, appendLine);
      if (type === "assistant_end") {
        close();
        if (typeof options.onComplete === "function") options.onComplete(payload);
      }
    };

    for (const type of ["user_message", "assistant_start", "progress", "preview", "awaiting_approval", "sources", "assistant_end"]) {
      source.addEventListener(type, (event) => {
        let payload = {};
        try {
          payload = JSON.parse(event.data);
        } catch {
          payload = {};
        }
        handle(type, payload);
      });
    }
    source.onerror = () => {
      close();
      if (typeof options.onError === "function") options.onError();
    };
    return source;
  }

  window.KimiCoworkRunEvents = Object.freeze({
    renderRunEventPayload,
    subscribeRunEvents,
  });
}());
