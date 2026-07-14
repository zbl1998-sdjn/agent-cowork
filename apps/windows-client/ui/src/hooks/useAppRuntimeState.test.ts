import { describe, expect, it } from 'vitest';
import { historyRunsFromIndex, runtimeDefaultsFromAgentEngineInfo } from './useAppRuntimeState';
import type { RunSummary } from '../lib/types';

describe('runtimeDefaultsFromAgentEngineInfo', () => {
  it('normalizes host Agent Engine info into App runtime defaults', () => {
    expect(runtimeDefaultsFromAgentEngineInfo({
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
      providers: [],
    });
  });

  it('derives provider options and model choices from opencode-style catalog', () => {
    const defaults = runtimeDefaultsFromAgentEngineInfo({
      chatEnabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      catalog: {
        connected: ['deepseek'],
        default: { deepseek: 'deepseek-v4-flash' },
        all: {
          ollama: {
            id: 'ollama',
            name: 'Ollama',
            source: 'config',
            env: [],
            options: { baseURL: 'http://127.0.0.1:11434/v1', requiresApiKey: false },
            models: {
              'qwen3:8b': { id: 'qwen3:8b', name: 'qwen3:8b', providerID: 'ollama', enabled: true },
              'deepseek-r1:7b': { id: 'deepseek-r1:7b', name: 'deepseek-r1:7b', providerID: 'ollama', enabled: true },
            },
          },
          deepseek: {
            id: 'deepseek',
            name: 'DeepSeek',
            source: 'env',
            env: ['DEEPSEEK_API_KEY'],
            options: { baseURL: 'https://api.deepseek.com', requiresApiKey: true },
            models: {
              'deepseek-v4-flash': { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', providerID: 'deepseek', enabled: true },
              'deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', providerID: 'deepseek', enabled: true },
            },
          },
        },
      },
    });

    expect(defaults.provider).toBe('deepseek');
    expect(defaults.models).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
    expect(defaults.providers.some((item) => item.id === 'deepseek')).toBe(true);
    expect(defaults.providers.find((item) => item.id === 'deepseek')?.apiKeyEnv).toEqual(['DEEPSEEK_API_KEY']);
    expect(defaults.providers.find((item) => item.id === 'ollama')).toMatchObject({
      region: 'local',
      allowCustomBaseUrl: true,
      requiresApiKey: false,
    });
  });

  it('keeps fallback provider and empty model list when info is partial', () => {
    expect(runtimeDefaultsFromAgentEngineInfo(null)).toEqual({
      chatEnabled: false,
      provider: 'kimi-api',
      baseUrl: '',
      model: '',
      models: [],
      providers: [],
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
