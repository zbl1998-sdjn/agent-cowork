// 运行历史 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:拉取运行历史列表/单条记录,并经 SSE 订阅单次运行的事件时间线。
// 对应路由:/api/tasks、/api/runs、/api/runs/:id、/api/runs/:id/events(SSE)。
// 导出:listTasks、listRunRecords、getRunRecord、subscribeRunEvents。
import type { RunEvent, RunRecord } from '../types';
import type { TaskSummary } from '../types/tasks';
import { getJson } from './transport';
import { authHeaders, requireHost, resolveUrl } from './transport';
import { responseErrorMessage, streamSse } from './sse';

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

export interface RunEventSubscriptionOptions {
  maxReconnects?: number | undefined;
  baseDelayMs?: number | undefined;
  maxDelayMs?: number | undefined;
  onError?: ((error: Error) => void) | undefined;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  const candidate = Number.isFinite(parsed) ? Math.round(parsed) : fallback;
  return Math.max(min, Math.min(max, candidate));
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function retryableRunEventStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function subscribeRunEvents(
  runId: string,
  onEvent: (event: RunEvent) => void,
  options: RunEventSubscriptionOptions = {},
): () => void {
  const controller = new AbortController();
  const maxReconnects = boundedInteger(options.maxReconnects, 4, 0, 8);
  const baseDelayMs = boundedInteger(options.baseDelayMs, 250, 0, 10_000);
  const maxDelayMs = boundedInteger(options.maxDelayMs, 4_000, baseDelayMs, 30_000);
  let stopped = false;
  let terminal = false;
  let lastEventId = 0;
  let delayTimer: ReturnType<typeof setTimeout> | null = null;
  let releaseDelay: (() => void) | null = null;
  let errorReported = false;

  const reportError = (error: Error): void => {
    if (errorReported || stopped || terminal) return;
    errorReported = true;
    options.onError?.(error);
  };
  const waitForReconnect = (delayMs: number): Promise<void> => new Promise((resolve) => {
    const release = () => {
      if (delayTimer !== null) clearTimeout(delayTimer);
      delayTimer = null;
      releaseDelay = null;
      resolve();
    };
    releaseDelay = release;
    delayTimer = setTimeout(release, delayMs);
  });

  const run = async (): Promise<void> => {
    let reconnects = 0;
    while (!stopped && !terminal) {
      let disconnectError = new Error('运行事件连接提前结束');
      try {
        await requireHost();
        const headers = authHeaders({ accept: 'text/event-stream' });
        if (lastEventId > 0) headers['last-event-id'] = String(lastEventId);
        const response = await fetch(resolveUrl(`/api/runs/${encodeURIComponent(runId)}/events`), {
          headers,
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = new Error(await responseErrorMessage(response, `运行事件接口返回 ${response.status}`));
          if (!retryableRunEventStatus(response.status)) {
            reportError(error);
            return;
          }
          throw error;
        }
        if (!response.body) throw new Error('运行事件接口没有返回可读流');
        await streamSse(response, (type, data) => {
          const seq = Number(data.seq);
          if (Number.isFinite(seq) && seq > 0) {
            if (seq <= lastEventId) return;
            lastEventId = seq;
          }
          if (!RUN_EVENT_TYPES.has(type)) return;
          try {
            onEvent({ type, ...data } as RunEvent);
          } catch (error) {
            reportError(asError(error, '运行事件处理失败'));
            stopped = true;
            controller.abort();
            return;
          }
          if (type === 'assistant_end') {
            terminal = true;
            controller.abort();
          }
        });
        if (stopped || terminal) return;
      } catch (error) {
        if (stopped || terminal || controller.signal.aborted) return;
        disconnectError = asError(error, '运行事件连接失败');
      }

      if (reconnects >= maxReconnects) {
        reportError(new Error(`运行事件自动重连 ${maxReconnects} 次后耗尽：${disconnectError.message}`));
        return;
      }
      const delayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** reconnects));
      reconnects += 1;
      await waitForReconnect(delayMs);
    }
  };

  void run().catch((error) => reportError(asError(error, '运行事件订阅失败')));
  return () => {
    stopped = true;
    releaseDelay?.();
    controller.abort();
  };
}

export async function listRunRecords(limit = 20): Promise<RunRecord[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.round(Number(limit) || 20)));
  const res = await getJson<{ runs?: RunRecord[] }>(`/api/runs?limit=${safeLimit}`);
  return Array.isArray(res.runs) ? res.runs : [];
}

export async function listTasks(limit = 20): Promise<TaskSummary[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.round(Number(limit) || 20)));
  const res = await getJson<{ tasks?: TaskSummary[] }>(`/api/tasks?limit=${safeLimit}`);
  return Array.isArray(res.tasks) ? res.tasks : [];
}

export async function getRunRecord(runId: string): Promise<RunRecord> {
  return getJson<RunRecord>(`/api/runs/${encodeURIComponent(runId)}`);
}
