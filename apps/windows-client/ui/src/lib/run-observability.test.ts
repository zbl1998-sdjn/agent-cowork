import { describe, expect, it } from 'vitest';
import {
  buildRunObservabilityView,
  selectInitialRunId,
} from './run-observability';
import type { RunRecord } from './types';

const record: RunRecord = {
  id: 'run_observe_1',
  type: 'agent',
  status: 'failed',
  promptPreview: '修复发布脚本',
  startedAt: '2026-05-25T00:00:00.000Z',
  durationMs: 2500,
  metrics: {
    schemaVersion: 1,
    provider: 'openai',
    model: 'kimi-k2-test',
    status: 'failed',
    tokens: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
    cost: { currency: 'USD', input: 0.0003, output: 0.00012, total: 0.00042, estimated: true, source: 'local-estimate', provider: 'openai' },
    duration: { totalMs: 2500, phases: [], unaccountedMs: 2500 },
    steps: { total: 4, succeeded: 3, failed: 1 },
    tools: { calls: 4, succeeded: 3, failed: 1, unique: ['Read', 'Shell'] },
    failures: { count: 1, rate: 0.25, runFailed: true },
  },
  attribution: {
    schemaVersion: 1,
    prompt: {
      inputSha256: 'abc123',
      inputChars: 128,
      systemPromptVersion: 'sp-2026-05-25',
      builder: 'agent-system-prompt',
    },
    model: {
      provider: 'kimi',
      model: 'kimi-k2-test',
      mode: 'agent',
      baseUrl: 'https://api.moonshot.cn/v1',
    },
    config: {
      maxSteps: 8,
      developerMode: true,
      apiKey: '[REDACTED]',
    },
  },
};

describe('run observability view model', () => {
  it('summarises run metrics and attribution without backend-specific rendering', () => {
    const view = buildRunObservabilityView(record);

    expect(view.title).toBe('修复发布脚本');
    expect(view.subtitle).toBe('agent · failed · run_observe_1');
    expect(view.cards).toEqual([
      { label: '用量', value: '1,200 tokens', detail: 'Prompt 1,000 / Completion 200', tone: 'neutral' },
      { label: '估算成本', value: '≈USD 0.00042', detail: 'openai · local-estimate', tone: 'neutral' },
      { label: '工具调用', value: '4 次', detail: '3 成功 / 1 失败', tone: 'warn' },
      { label: '失败率', value: '25.0%', detail: '运行失败', tone: 'danger' },
      { label: '模型', value: 'kimi-k2-test', detail: 'openai / agent', tone: 'neutral' },
    ]);
    expect(view.toolNames).toEqual(['Read', 'Shell']);
    expect(view.attributionRows).toEqual([
      { label: 'Provider', value: 'openai' },
      { label: 'System prompt', value: 'sp-2026-05-25' },
      { label: 'Prompt builder', value: 'agent-system-prompt' },
      { label: 'Prompt chars', value: '128' },
      { label: 'Prompt hash', value: 'abc123' },
      { label: 'Base URL', value: 'https://api.moonshot.cn/v1' },
    ]);
    expect(view.configRows).toEqual([
      { label: 'maxSteps', value: '8' },
      { label: 'developerMode', value: 'true' },
      { label: 'apiKey', value: '[REDACTED]' },
    ]);
  });

  it('keeps sparse or pending records displayable', () => {
    const view = buildRunObservabilityView({
      id: 'run_pending',
      type: 'chat',
      status: 'pending',
      promptPreview: null,
      metrics: null,
      attribution: null,
    });

    expect(view.title).toBe('run_pending');
    expect(view.cards.map((card) => card.value)).toEqual(['0 tokens', '≈USD 0.00', '0 次', '0.0%', '未记录']);
    expect(view.cards[1].detail).toBe('未记录 · local-estimate');
    expect(view.isSparse).toBe(true);
  });

  it('preserves the selected run when it is still present', () => {
    expect(selectInitialRunId([record], 'run_observe_1')).toBe('run_observe_1');
    expect(selectInitialRunId([record], 'missing')).toBe('run_observe_1');
    expect(selectInitialRunId([], 'missing')).toBeNull();
  });
});
