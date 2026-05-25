import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SubtaskGroups } from './SubtaskGroups';

describe('SubtaskGroups', () => {
  it('renders grouped child-agent progress with stable labels', () => {
    const html = renderToStaticMarkup(
      <SubtaskGroups
        items={[
          { index: 0, goal: '审查 A 文件夹', status: 'running', stepCount: 2 },
          { index: 1, goal: '审查 B 文件夹', status: 'done', runId: 'run_child_b' },
          { index: 2, goal: '审查 C 文件夹', status: 'failed', error: 'timeout' },
        ]}
      />,
    );

    expect(html).toContain('子任务分组');
    expect(html).toContain('审查 A 文件夹');
    expect(html).toContain('进行中');
    expect(html).toContain('完成');
    expect(html).toContain('timeout');
  });
});
