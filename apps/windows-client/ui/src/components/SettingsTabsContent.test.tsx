import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SettingsTabsContent, type SettingsPersistPayload } from './SettingsTabsContent';
import type { ModelProviderOption } from '../lib/api';

const providers: ModelProviderOption[] = [
  { id: 'kimi-api', displayName: 'Kimi', region: 'cn', protocol: 'openai-chat', defaultModel: 'kimi-k2.7-code', models: ['kimi-k2.7-code'], defaultBaseUrl: 'https://api.moonshot.ai/v1', apiKeyEnv: ['KIMI_API_KEY'], requiresApiKey: true, source: 'builtin' },
  { id: 'deepseek', displayName: 'DeepSeek', region: 'cn', protocol: 'openai-chat', defaultModel: 'deepseek-v4-flash', models: ['deepseek-v4-flash', 'deepseek-v4-pro'], defaultBaseUrl: 'https://api.deepseek.com', apiKeyEnv: ['DEEPSEEK_API_KEY'], requiresApiKey: true, source: 'builtin' },
  { id: 'openai/local', displayName: 'Local', region: 'local', protocol: 'openai-chat', defaultModel: 'qwen2.5-coder:7b', models: ['qwen2.5-coder:7b'], defaultBaseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: [], requiresApiKey: false, source: 'builtin' },
];

function render(tab: 'appearance' | 'model' | 'api'): string {
  const persist = vi.fn<(payload: SettingsPersistPayload, okMsg: string) => void>();
  return renderToStaticMarkup(
    <SettingsTabsContent
      tab={tab}
      username="user"
      tenantId="tenant"
      onLogout={vi.fn()}
      theme="light"
      onSetTheme={vi.fn()}
      fontScale="large"
      onSetFontScale={vi.fn()}
      fontFamily="chinese"
      onSetFontFamily={vi.fn()}
      autoClarify={false}
      onSetAutoClarify={vi.fn()}
      provider="deepseek"
      setProvider={vi.fn()}
      providers={providers}
      model="deepseek-v4-flash"
      setModel={vi.fn()}
      baseUrl="https://api.deepseek.com"
      setBaseUrl={vi.fn()}
      apiKey=""
      setApiKey={vi.fn()}
      hasKey={false}
      loading={false}
      busy={false}
      persist={persist}
      selfCheck={null}
      scError=""
      scLoading={false}
      onRefreshSelfCheck={vi.fn()}
      error=""
      savedTip=""
    />,
  );
}

describe('SettingsTabsContent provider catalog', () => {
  it('uses host provider catalog for the default model tab', () => {
    const html = render('model');

    expect(html).toContain('value="deepseek"');
    expect(html).toContain('DeepSeek');
    expect(html).toContain('value="deepseek-v4-flash"');
    expect(html).toContain('provider_id/model_id');
  });

  it('shows provider-specific API configuration metadata without keys', () => {
    const html = render('api');

    expect(html).toContain('DEEPSEEK_API_KEY');
    expect(html).toContain('https://api.deepseek.com');
    expect(html).toContain('粘贴 API Key');
    expect(html).not.toContain('test-secret');
  });

  it('renders appearance font preferences from the shared settings state', () => {
    const html = render('appearance');

    expect(html).toContain('aria-label="字体大小"');
    expect(html).toContain('aria-label="字体"');
    expect(html).toContain('>大</button>');
    expect(html).toContain('>中文</button>');
    expect(html).toContain('aria-pressed="true"');
  });
});
