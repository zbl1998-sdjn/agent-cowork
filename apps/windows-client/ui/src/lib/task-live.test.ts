import { describe, expect, it } from 'vitest';
import type { RunEvent } from './types';
import { initialTaskLiveState, reduceTaskLiveEvent, taskLiveEventLabel } from './task-live';

const ev = (partial: Partial<RunEvent> & { type: RunEvent['type'] }): RunEvent => ({ seq: 1, ts: '2026-07-17T00:00:00Z', ...partial } as RunEvent);

describe('reduceTaskLiveEvent', () => {
  it('tracks pending approvals in and out by id', () => {
    let state = initialTaskLiveState();
    state = reduceTaskLiveEvent(state, ev({ type: 'approval_request', id: 'ap1', name: 'Write', risk: 'write' }));
    state = reduceTaskLiveEvent(state, ev({ type: 'approval_request', id: 'ap1', name: 'Write' }));
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]).toMatchObject({ id: 'ap1', name: 'Write', risk: 'write' });

    state = reduceTaskLiveEvent(state, ev({ type: 'approval_resolved', id: 'ap1', approved: true }));
    expect(state.pending).toHaveLength(0);
    expect(state.finished).toBe(false);
  });

  it('marks the stream finished and clears pending on done/assistant_end', () => {
    let state = initialTaskLiveState();
    state = reduceTaskLiveEvent(state, ev({ type: 'approval_request', id: 'ap2', name: 'Edit' }));
    state = reduceTaskLiveEvent(state, ev({ type: 'done' }));
    expect(state.finished).toBe(true);
    expect(state.pending).toHaveLength(0);
  });

  it('caps the timeline at 50 events', () => {
    let state = initialTaskLiveState();
    for (let i = 0; i < 60; i += 1) state = reduceTaskLiveEvent(state, ev({ type: 'progress', seq: i, text: `第 ${i} 步` }));
    expect(state.timeline).toHaveLength(50);
    expect(state.timeline[0]?.text).toBe('第 10 步');
  });
});

describe('taskLiveEventLabel', () => {
  it('prefers event text, then approval phrasing, then type', () => {
    expect(taskLiveEventLabel(ev({ type: 'progress', text: '正在读取文件' }))).toBe('正在读取文件');
    expect(taskLiveEventLabel(ev({ type: 'approval_request', name: 'Write' }))).toBe('等待审批:Write');
    expect(taskLiveEventLabel(ev({ type: 'approval_resolved', approved: false }))).toBe('审批已拒绝');
    expect(taskLiveEventLabel(ev({ type: 'sources' }))).toBe('sources');
  });
});
