import type { RunEvent } from '../types';
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
