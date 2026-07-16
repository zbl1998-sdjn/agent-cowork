// task-live(UI · lib 纯逻辑层)
// ---------------------------------------------------------------------------
// 职责:把任务中心 attach 到的 run 事件流归约成可渲染状态——最近时间线(封顶)、
//       待审批清单(approval_request 进、approval_resolved 出)与是否已结束。纯函数。
import type { RunEvent } from './types';

export type PendingRunApproval = { id: string; name: string; risk?: string; preview?: unknown };
export type TaskLiveState = { timeline: RunEvent[]; pending: PendingRunApproval[]; finished: boolean };

const TIMELINE_CAP = 50;

export function initialTaskLiveState(): TaskLiveState {
  return { timeline: [], pending: [], finished: false };
}

export function reduceTaskLiveEvent(state: TaskLiveState, event: RunEvent): TaskLiveState {
  const timeline = [...state.timeline, event].slice(-TIMELINE_CAP);
  if (event.type === 'approval_request') {
    const id = String(event.id || '');
    if (!id || state.pending.some((item) => item.id === id)) return { ...state, timeline };
    const entry: PendingRunApproval = { id, name: String(event.name || '') };
    if (typeof event.risk === 'string') entry.risk = event.risk;
    if (event.preview !== undefined) entry.preview = event.preview;
    return { ...state, timeline, pending: [...state.pending, entry] };
  }
  if (event.type === 'approval_resolved') {
    const id = String(event.id || '');
    return { ...state, timeline, pending: state.pending.filter((item) => item.id !== id) };
  }
  if (event.type === 'assistant_end' || event.type === 'done') {
    return { timeline, pending: [], finished: true };
  }
  return { ...state, timeline };
}

/** 时间线条目的一句话标签:优先事件自带文本,其次状态,兜底事件类型。 */
export function taskLiveEventLabel(event: RunEvent): string {
  const text = typeof event.text === 'string' && event.text.trim() ? event.text.trim() : '';
  if (text) return text;
  if (event.type === 'tool_result') return `工具 ${String(event.name || '')} ${String(event.status || '')}`.trim();
  if (event.type === 'approval_request') return `等待审批:${String(event.name || '')}`;
  if (event.type === 'approval_resolved') return `审批已${event.approved === true ? '通过' : '拒绝'}`;
  if (typeof event.status === 'string' && event.status) return `${event.type}(${event.status})`;
  return event.type;
}
