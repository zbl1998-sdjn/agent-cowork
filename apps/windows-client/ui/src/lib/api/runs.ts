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
      /* aborted or host unreachable */
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
