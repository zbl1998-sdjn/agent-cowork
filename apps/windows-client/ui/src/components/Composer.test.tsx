import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Composer, mergeComposerFiles } from './Composer';

function renderComposer(): string {
  return renderToStaticMarkup(
    <Composer
      recipes={[]}
      historyRuns={[]}
      searchFiles={async () => []}
      models={['moonshot-v1']}
      defaultModel="moonshot-v1"
      defaultProvider="kimi-api"
      defaultBaseUrl="https://api.moonshot.test/v1"
      onSend={vi.fn()}
    />,
  );
}

function renderComposerWithProviders(): string {
  return renderToStaticMarkup(
    <Composer
      recipes={[]}
      historyRuns={[]}
      searchFiles={async () => []}
      models={[]}
      modelProviders={[
        { id: 'kimi-api', displayName: 'Kimi', region: 'cn', protocol: 'openai-chat', defaultModel: 'kimi-k2.7-code', models: ['kimi-k2.7-code'], defaultBaseUrl: 'https://api.moonshot.ai/v1', apiKeyEnv: ['KIMI_API_KEY'], requiresApiKey: true, source: 'builtin' },
        { id: 'deepseek', displayName: 'DeepSeek', region: 'cn', protocol: 'openai-chat', defaultModel: 'deepseek-v4-flash', models: ['deepseek-v4-flash', 'deepseek-v4-pro'], defaultBaseUrl: 'https://api.deepseek.com', apiKeyEnv: ['DEEPSEEK_API_KEY'], requiresApiKey: true, source: 'builtin' },
      ]}
      defaultModel="deepseek-v4-flash"
      defaultProvider="deepseek"
      defaultBaseUrl="https://api.deepseek.com"
      onSend={vi.fn()}
    />,
  );
}

function renderComposerWithFallbackOllama(): string {
  return renderToStaticMarkup(
    <Composer
      recipes={[]}
      historyRuns={[]}
      searchFiles={async () => []}
      models={[]}
      defaultModel=""
      defaultProvider="ollama"
      onSend={vi.fn()}
    />,
  );
}

describe('Composer', () => {
  it('renders per-session provider + model controls but NOT credential fields', () => {
    const html = renderComposer();

    expect(html).toContain('class="composer-footer-right"'); // 模型控件直接可见,不再折叠进「高级」
    expect(html).toContain('provider-select');
    expect(html).toContain('title="本轮模型提供商"');
    expect(html).toContain('placeholder="今天想完成什么？例如：帮我把这些表格合并成一个总表"');
    expect(html).toContain('value="openai"');
    expect(html).toContain('value="anthropic"');
    expect(html).toContain('value="ollama"');
    expect(html).toContain('value="openai/local"');
    expect(html).toContain('value="lmstudio"');
    expect(html).toContain('class="model-picker"'); // 模型选择器(精选菜单 + 手输)
    expect(html).toContain('aria-label="本轮模型"');
    expect(html).toContain('type="file"');
    expect(html).toContain('multiple=""');
    expect(html).toContain('aria-label="选择附件文件"');
    // Base URL / API Key 已移到 Settings;凭据绝不能出现在输入框组件里。
    expect(html).not.toContain('title="本轮 Base URL"');
    expect(html).not.toContain('placeholder="本轮 API Key"');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('sk-session');
  });

  it('renders provider catalog entries from the host', () => {
    const html = renderComposerWithProviders();

    expect(html).toContain('value="deepseek"');
    expect(html).toContain('DeepSeek');
    // 模型全量改精选菜单(交互展开选或手输),SSR 收起态不渲染具体 model option
    expect(html).toContain('class="model-picker"');
    expect(html).not.toContain('DEEPSEEK_API_KEY');
    expect(html).not.toContain('type="password"');
  });

  it('keeps multiple local fallback models available before host catalog loads', () => {
    const html = renderComposerWithFallbackOllama();

    expect(html).toContain('value="ollama"'); // provider 下拉含 ollama
    expect(html).toContain('class="model-picker"'); // 模型精选菜单(展开可选本地模型,或手输)
  });

  it('deduplicates dropped or selected files by browser file identity', () => {
    const first = new File(['a'], 'same.txt', { type: 'text/plain', lastModified: 1 });
    const duplicate = new File(['a'], 'same.txt', { type: 'text/plain', lastModified: 1 });
    const second = new File(['b'], 'same.txt', { type: 'text/plain', lastModified: 2 });

    expect(mergeComposerFiles([first], [duplicate, second]).map((file) => file.lastModified)).toEqual([1, 2]);
  });
});
