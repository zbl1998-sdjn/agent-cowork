(function () {
  function compactText(text, maxLength = 220) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength - 1)}…`;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function basename(filePath) {
    return String(filePath || "").split(/[\\/]/).filter(Boolean).pop() || filePath;
  }

  function joinWin(root, ...parts) {
    return [root.replace(/[\\/]+$/, ""), ...parts.map((part) => String(part).replace(/^[\\/]+|[\\/]+$/g, ""))].join("\\");
  }

  function uniqueStamp(date = new Date()) {
    const timestamp = date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
    const suffix = Math.random().toString(16).slice(2, 6);
    return `${timestamp}-${suffix}`;
  }

  function idempotencyKey(prefix = "kcw") {
    if (window.crypto?.randomUUID) {
      return `${prefix}-${window.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function messageStatusClass(status) {
    if (/失败|错误|受阻/.test(status || "")) {
      return "is-error";
    }
    if (/等待|审批/.test(status || "")) {
      return "is-waiting";
    }
    if (/完成|已回复|已执行|就绪/.test(status || "")) {
      return "is-done";
    }
    if (/中|正在|计划|读取|调用|处理/.test(status || "")) {
      return "is-running";
    }
    return "";
  }

  function progressStateFromIcon(icon) {
    if (icon === "check") return "done";
    if (icon === "loader") return "running";
    return "wait";
  }

  function shortRunId(runId) {
    return String(runId || "").split("_").slice(-1)[0] || runId;
  }

  function runStatusText(status) {
    if (status === "succeeded") return "完成";
    if (status === "failed") return "失败";
    return "运行中";
  }

  function runTypeText(run) {
    if (run.type === "kimi-chat") {
      return "对话";
    }
    if (run.mode === "code") {
      return "代码";
    }
    return "协作";
  }

  function formatDuration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) {
      return "未知耗时";
    }
    if (value < 1000) {
      return `${Math.round(value)}ms`;
    }
    return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s`;
  }

  function formatRunTime(value) {
    if (!value) {
      return "刚刚";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "刚刚";
    }
    return date.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  window.AgentCoworkUtils = Object.freeze({
    arrayBufferToBase64,
    basename,
    compactText,
    formatDuration,
    formatRunTime,
    idempotencyKey,
    joinWin,
    messageStatusClass,
    progressStateFromIcon,
    runStatusText,
    runTypeText,
    shortRunId,
    uniqueStamp,
  });
}());
