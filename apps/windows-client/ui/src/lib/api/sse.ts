// SSE 流解析(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:逐帧解析 host 的 Server-Sent Events 响应体,拆出事件类型与 JSON 负载回调给上层(聊天/运行时间线);并从错误响应提取消息。
// 导出:streamSse、responseErrorMessage、SsePayload 类型。
export type SsePayload = Record<string, unknown>;

export async function streamSse(response: Response, onFrame: (type: string, data: SsePayload) => void): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const evMatch = /^event:\s*(.*)$/m.exec(frame);
      const dataMatch = /^data:\s*(.*)$/m.exec(frame);
      const eventType = evMatch?.[1];
      if (!eventType) continue;

      let data: SsePayload = {};
      try {
        const parsed = dataMatch?.[1] ? JSON.parse(dataMatch[1]) : {};
        if (parsed && typeof parsed === 'object') data = parsed as SsePayload;
      } catch {
        /* ignore malformed frame */
      }
      onFrame(eventType.trim(), data);
    }
  }
}

export async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: string };
    return payload.error || fallback;
  } catch {
    return fallback;
  }
}
