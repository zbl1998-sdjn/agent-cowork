import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AgentTeamTimeline } from './AgentTeamTimeline';
import type { AgentTeamTimelineView } from '../lib/agent-team-timeline';

function collectByType(node: ReactNode, type: unknown): ReactElement<Record<string, any>>[] {
  const matches: ReactElement<Record<string, any>>[] = [];
  const visit = (value: ReactNode) => {
    Children.forEach(value, (child) => {
      if (!isValidElement(child)) return;
      if (child.type === type) matches.push(child as ReactElement<Record<string, any>>);
      visit((child.props as { children?: ReactNode }).children);
    });
  };
  visit(node);
  return matches;
}

const view: AgentTeamTimelineView = {
  runId: 'run_team_1',
  title: '生成本周交付报告',
  subtitle: 'weekly-report · workflow · run_team_1',
  statusLabel: '已完成',
  tone: 'done',
  agentCount: 2,
  eventCount: 8,
  evidenceCount: 1,
  warningCount: 1,
  artifactCount: 1,
  agents: [
    { id: 'researcher', label: '研究员', taskTitle: '汇总事实', statusLabel: '成功', tone: 'done', summary: '事实已汇总', confidence: '92%', usage: '1 次模型 / 170 tokens', evidenceCount: 1, warningCount: 0 },
    { id: 'writer', label: '写作者', taskTitle: '撰写报告', statusLabel: '部分完成', tone: 'warn', summary: '草稿已生成', confidence: '81%', usage: '1 次模型 / 1 次工具 / 100 tokens', evidenceCount: 0, warningCount: 1 },
  ],
  events: [
    { key: '1', label: '任务完成', actor: '研究员', detail: '事实已汇总', at: '01:00:03', tone: 'done' },
    { key: '2', label: '结束', actor: '编排器', detail: '已完成', at: '01:00:07', tone: 'done' },
  ],
  budgets: [
    { key: 'modelCalls', label: '模型调用', used: '2', limit: '10', remaining: '8', percent: 20 },
  ],
};

describe('AgentTeamTimeline', () => {
  it('renders team status, trust summary, timeline, and budget rows', () => {
    const html = renderToStaticMarkup(<AgentTeamTimeline view={view} />);

    expect(html).toContain('Agent Team');
    expect(html).toContain('已完成');
    expect(html).toContain('生成本周交付报告');
    expect(html).toContain('研究员');
    expect(html).toContain('写作者');
    expect(html).toContain('任务完成');
    expect(html).toContain('模型调用');
    expect(html).toContain('余 8');
  });

  it('renders empty/loading/error states and wires actions', () => {
    const onRefresh = vi.fn();
    const onOpenRuns = vi.fn();
    const tree = AgentTeamTimeline({ view: null, loading: true, error: '读取失败', onRefresh, onOpenRuns });
    const html = renderToStaticMarkup(tree);
    const buttons = collectByType(tree, 'button');

    expect(html).toContain('读取中');
    expect(html).toContain('读取失败');
    buttons[0]!.props.onClick();
    buttons[1]!.props.onClick();
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onOpenRuns).toHaveBeenCalledOnce();
  });
});
