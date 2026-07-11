import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskDetailView } from './TaskDetailView';

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
});
