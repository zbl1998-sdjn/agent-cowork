import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';

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

describe('Composer', () => {
  it('renders per-session provider + model controls but NOT credential fields', () => {
    const html = renderComposer();

    expect(html).toContain('title="本轮模型提供商"');
    expect(html).toContain('value="openai"');
    expect(html).toContain('value="anthropic"');
    expect(html).toContain('value="openai/local"');
    expect(html).toContain('title="本轮模型"');
    // Base URL / API Key moved to Settings — credentials must not live in the composer.
    expect(html).not.toContain('title="本轮 Base URL"');
    expect(html).not.toContain('placeholder="本轮 API Key"');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('sk-session');
  });
});
