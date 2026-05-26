import { describe, expect, it } from 'vitest';
import { historyRunsFromIndex, runtimeDefaultsFromKimiInfo } from './useAppRuntimeState';
import type { RunSummary } from '../lib/types';

describe('runtimeDefaultsFromKimiInfo', () => {
  it('normalizes host Kimi info into App runtime defaults', () => {
    expect(runtimeDefaultsFromKimiInfo({
      chatEnabled: true,
      provider: 'anthropic',
      baseUrl: 'https://anthropic.test',
      model: 'claude-test',
    })).toEqual({
      chatEnabled: true,
      provider: 'anthropic',
      baseUrl: 'https://anthropic.test',
      model: 'claude-test',
      models: ['claude-test'],
    });
  });

  it('keeps fallback provider and empty model list when info is partial', () => {
    expect(runtimeDefaultsFromKimiInfo(null)).toEqual({
      chatEnabled: false,
      provider: 'kimi-api',
      baseUrl: '',
      model: '',
      models: [],
    });
  });
});

describe('historyRunsFromIndex', () => {
  it('maps run index summaries to Composer history suggestions', () => {
    const runs: RunSummary[] = [
      { id: 'run_1', type: 'agent', status: 'done', promptPreview: '整理日报' },
      { id: 'run_2', type: 'agent', status: 'failed', promptPreview: null },
    ];

    expect(historyRunsFromIndex(runs)).toEqual([
      { id: 'run_1', promptPreview: '整理日报' },
      { id: 'run_2', promptPreview: null },
    ]);
  });
});
