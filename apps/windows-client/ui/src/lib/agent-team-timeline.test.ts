import { describe, expect, it } from 'vitest';
import { buildAgentTeamTimelineView, isOrchestratorRecord } from './agent-team-timeline';
import type { RunRecord } from './types';

const orchestratorRecord: RunRecord = {
  id: 'run_team_1',
  type: 'orchestrator',
  status: 'completed',
  input: { prompt: '生成本周交付报告' },
  events: [
    { type: 'run_started', runId: 'run_team_1', goal: '生成本周交付报告', at: '2026-07-05T01:00:00.000Z' },
    { type: 'recipe_selected', runId: 'run_team_1', recipeId: 'weekly-report', reason: 'goal matched weekly report', at: '2026-07-05T01:00:01.000Z' },
    { type: 'agent_task_started', runId: 'run_team_1', taskId: 'research', agentId: 'researcher', title: '汇总事实', at: '2026-07-05T01:00:02.000Z' },
    { type: 'agent_task_completed', runId: 'run_team_1', taskId: 'research', agentId: 'researcher', status: 'succeeded', summary: '事实已汇总', at: '2026-07-05T01:00:03.000Z' },
    { type: 'agent_task_started', runId: 'run_team_1', taskId: 'write', agentId: 'writer', title: '撰写报告', at: '2026-07-05T01:00:04.000Z' },
    { type: 'agent_task_completed', runId: 'run_team_1', taskId: 'write', agentId: 'writer', status: 'partial', summary: '草稿已生成', at: '2026-07-05T01:00:05.000Z' },
    {
      type: 'budget_updated',
      runId: 'run_team_1',
      budget: {
        used: { modelCalls: 2, toolCalls: 1, inputTokens: 180, outputTokens: 90, runtimeMs: 1500, filesRead: 2, bytesRead: 4096 },
        limit: { modelCalls: 10, toolCalls: 20, inputTokens: 1000, outputTokens: 600, runtimeMs: 60000, filesRead: 10, bytesRead: 10000 },
        remaining: { modelCalls: 8, toolCalls: 19, inputTokens: 820, outputTokens: 510, runtimeMs: 58500, filesRead: 8, bytesRead: 5904 },
      },
      at: '2026-07-05T01:00:06.000Z',
    },
    { type: 'run_completed', runId: 'run_team_1', status: 'completed', at: '2026-07-05T01:00:07.000Z' },
  ],
  orchestratorRun: {
    runId: 'run_team_1',
    userGoal: '生成本周交付报告',
    recipeId: 'weekly-report',
    mode: 'workflow',
    status: 'completed',
    agents: ['researcher', 'writer'],
    tasks: [
      { taskId: 'research', agentId: 'researcher', title: '汇总事实' },
      { taskId: 'write', agentId: 'writer', title: '撰写报告' },
    ],
    results: [
      {
        taskId: 'research',
        agentId: 'researcher',
        status: 'succeeded',
        summary: '事实已汇总',
        confidence: 0.92,
        usage: { modelCalls: 1, inputTokens: 120, outputTokens: 50 },
        evidenceRefs: [{ refId: 'src1', label: '周报数据', uri: 'file://report.md' }],
        warnings: [],
      },
      {
        taskId: 'write',
        agentId: 'writer',
        status: 'partial',
        summary: '草稿已生成',
        confidence: 0.81,
        usage: { modelCalls: 1, toolCalls: 1, inputTokens: 60, outputTokens: 40 },
        evidenceRefs: [],
        warnings: ['需要人工补图表'],
        artifactRefs: ['draft:weekly-report'],
      },
    ],
    artifacts: ['draft:weekly-report'],
  },
};

describe('agent team timeline view model', () => {
  it('builds a compact team, event, budget, and trust summary from an orchestrator run', () => {
    const view = buildAgentTeamTimelineView(orchestratorRecord);

    expect(view).toMatchObject({
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
    });
    expect(view?.agents.map((agent) => [agent.label, agent.statusLabel, agent.confidence])).toEqual([
      ['研究员', '成功', '92%'],
      ['写作者', '部分完成', '81%'],
    ]);
    expect(view?.events.at(-1)).toMatchObject({ label: '结束', actor: '编排器', detail: '已完成', at: '01:00:07' });
    expect(view?.budgets.find((row) => row.key === 'modelCalls')).toMatchObject({ used: '2', limit: '10', remaining: '8', percent: 20 });
    expect(view?.budgets.find((row) => row.key === 'inputTokens')).toMatchObject({ used: '180 tokens', limit: '1,000 tokens', remaining: '820 tokens', percent: 18 });
  });

  it('ignores non-orchestrator records', () => {
    expect(isOrchestratorRecord({ type: 'agent' })).toBe(false);
    expect(buildAgentTeamTimelineView({ id: 'run_chat', type: 'agent', status: 'done' })).toBeNull();
  });
});
