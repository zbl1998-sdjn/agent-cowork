import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TaskLiveEvents } from '../../hooks/useTaskLiveEvents';
import { TaskDetailView } from './TaskDetailView';

function liveState(partial: Partial<TaskLiveEvents> = {}): TaskLiveEvents {
  return {
    timeline: [],
    pending: [],
    finished: false,
    streamError: '',
    respondBusy: '',
    respond: vi.fn(),
    ...partial,
  };
}

describe('TaskDetailView', () => {
  it('renders the selected owner-scoped run record as a read-only detail', () => {
    const html = renderToStaticMarkup(<TaskDetailView
      busy={false}
      error=""
      record={{
        id: 'run_detail',
        type: 'agent-chat',
        status: 'done',
        prompt: '整理合同差异',
        provider: 'kimi',
        durationMs: 1250,
      }}
      onClose={() => {}}
    />);

    expect(html).toContain('任务详情');
    expect(html).toContain('run_detail');
    expect(html).toContain('整理合同差异');
    expect(html).toContain('agent-chat');
    expect(html).toContain('done');
    expect(html).toContain('关闭');
  });

  it('renders pending approvals with approve/reject and a stop button while running', () => {
    const html = renderToStaticMarkup(<TaskDetailView
      busy={false}
      error=""
      record={{ id: 'run_live', type: 'agent-chat', status: 'running' }}
      live={liveState({ pending: [{ id: 'ap1', name: 'Write', risk: 'write' }] })}
      onStop={vi.fn()}
      onClose={() => {}}
    />);
    expect(html).toContain('实时动态');
    expect(html).toContain('等待批准');
    expect(html).toContain('Write');
    expect(html).toContain('批准');
    expect(html).toContain('拒绝');
    expect(html).toContain('停止任务');
  });

  it('hides the stop button and marks the section finished after the run ends', () => {
    const html = renderToStaticMarkup(<TaskDetailView
      busy={false}
      error=""
      record={{ id: 'run_live', type: 'agent-chat', status: 'done' }}
      live={liveState({ finished: true })}
      onStop={vi.fn()}
      onClose={() => {}}
    />);
    expect(html).toContain('已结束');
    expect(html).not.toContain('停止任务');
  });
});
