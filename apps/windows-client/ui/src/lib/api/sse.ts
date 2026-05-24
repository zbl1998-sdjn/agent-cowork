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
      if (!evMatch) continue;

      let data: SsePayload = {};
      try {
        const parsed = dataMatch ? JSON.parse(dataMatch[1]) : {};
        if (parsed && typeof parsed === 'object') data = parsed as SsePayload;
      } catch {
        /* ignore malformed frame */
      }
      onFrame(evMatch[1].trim(), data);
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
