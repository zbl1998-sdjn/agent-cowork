import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ComposerModelControls } from './ComposerModelControls';
import type { ModelProviderOption } from '../lib/api';

describe('ComposerModelControls provider availability', () => {
  it('disables unavailable providers and explains why in the option label', () => {
    const providers = [
      {
        id: 'ollama', displayName: 'Ollama', runtimeState: {
          configured: true, enabled: true, policyDecision: 'allow',
        },
      },
      {
        id: 'openai', displayName: 'OpenAI', runtimeState: {
          configured: true, enabled: false, policyDecision: 'needs_approval',
        },
      },
      {
        id: 'anthropic', displayName: 'Anthropic', runtimeState: {
          configured: false, enabled: false, policyDecision: 'needs_approval',
        },
      },
    ] as unknown as ModelProviderOption[];
    const html = renderToStaticMarkup(
      <ComposerModelControls
        model="qwen3:14b"
        modelOptions={['qwen3:14b']}
        providerOptions={providers}
        provider="ollama"
        defaultModel="qwen3:14b"
        onProvider={vi.fn()}
        onModel={vi.fn()}
      />,
    );

    expect(html).toContain('OpenAI（受安全策略限制）');
    expect(html).toContain('Anthropic（未配置）');
    expect(html).toMatch(/option[^>]+disabled[^>]+value="openai"|option[^>]+value="openai"[^>]+disabled/);
  });
});
