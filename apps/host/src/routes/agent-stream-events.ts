// Agent 流事件安全边界(host · L3 路由层 · routes):统一脱敏 SSE 与运行诊断共用的事件载荷。
import { redactValue } from '../security/redaction.js';

export function sanitizeAgentEventData(data: unknown): Record<string, unknown> {
  const eventData = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : { value: data };
  try {
    return redactValue(eventData) as Record<string, unknown>;
  } catch {
    return { error: '事件载荷无法安全脱敏，内容已省略' };
  }
}
