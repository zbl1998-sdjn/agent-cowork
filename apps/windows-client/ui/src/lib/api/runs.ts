// 运行历史 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:拉取运行历史列表/单条记录,并经 SSE 订阅单次运行的事件时间线。
// 对应路由:/api/runs、/api/runs/:id、/api/runs/:id/events(SSE)。
// 导出:listRunRecords、getRunRecord、subscribeRunEvents。
import type { RunEvent, RunRecord } from '../types';
import { getJson } from './transport';
import { authHeaders, hostReady, resolveUrl } from './transport';
import { streamSse } from './sse';

const RUN_EVENT_TYPES = new Set<string>([
  'user_message',
  'assistant_start',
  'progress',
  'preview',
  'awaiting_approval',
  'sources',
  'assistant_end',
  'sandbox_start',
  'sandbox_end',
  'tool_result',
  'todo_snapshot',
  'todo_update',
  'child_start',
  'child_end',
]);

export function subscribeRunEvents(runId: string, onEvent: (event: RunEvent) => void): () => void {
  const controller = new AbortController();
  void (async () => {
    try {
      await hostReady;
      const response = await fetch(resolveUrl(`/api/runs/${encodeURIComponent(runId)}/events`), {
        headers: authHeaders({ accept: 'text/event-stream' }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) return;
      await streamSse(response, (type, data) => {
        if (RUN_EVENT_TYPES.has(type)) onEvent({ type, ...data } as RunEvent);
      });
    } catch {
      /* 订阅被取消或 host 暂不可达 */
    }
  })();
  return () => controller.abort();
}

export async function listRunRecords(limit = 20): Promise<RunRecord[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.round(Number(limit) || 20)));
  const res = await getJson<{ runs?: RunRecord[] }>(`/api/runs?limit=${safeLimit}`);
  return Array.isArray(res.runs) ? res.runs : [];
}

export async function getRunRecord(runId: string): Promise<RunRecord> {
  return getJson<RunRecord>(`/api/runs/${encodeURIComponent(runId)}`);
}
