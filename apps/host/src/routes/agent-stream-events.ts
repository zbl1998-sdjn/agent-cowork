// Agent 流事件安全边界(host · L3 路由层 · routes):统一脱敏 SSE 与运行诊断共用的事件载荷,
// 并提供把同一份脱敏事件同时送 SSE、诊断数组与 run 事件总线(任务中心 attach/断线回放)的发射器。
import { sse } from '../engine/agent/finalize.js';
import { redactValue } from '../security/redaction.js';
import { bindRunEventPublisher, type RunEventPublisher } from '../util/run-event-publisher.js';

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

export type AgentRunEmitterOptions = {
  response: Parameters<typeof sse>[0];
  events: Array<Record<string, unknown>>;
  runEvents?: unknown;
  requestContext?: { tenantId?: unknown; userId?: unknown };
  runId: string;
};

/** 构造对话流的事件发射器:同一份脱敏载荷进 SSE、诊断数组与 run 事件总线;总线失败不打断对话。 */
export function createAgentRunEmitter({ response, events, runEvents, requestContext, runId }: AgentRunEmitterOptions): (type: string, data: unknown) => void {
  const bus = runEvents && typeof (runEvents as RunEventPublisher).publish === 'function'
    ? bindRunEventPublisher(runEvents as RunEventPublisher, requestContext)
    : null;
  return (type, data) => {
    const safeEventData = sanitizeAgentEventData(data);
    events.push({ type, ...safeEventData });
    sse(response, type, safeEventData);
    try { bus?.publish(runId, { type, ...safeEventData }); } catch { /* 总线发布失败只影响 attach 视图 */ }
  };
}
