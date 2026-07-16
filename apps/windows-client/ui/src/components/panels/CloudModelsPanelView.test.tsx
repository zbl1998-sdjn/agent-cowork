import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CloudModelsPanelView } from './CloudModelsPanelView';

const noop = vi.fn();
const available = [
  { id: 'deepseek', displayName: 'DeepSeek（目录/当前受限）', host: 'api.deepseek.com' },
  { id: 'openai', displayName: 'OpenAI（目录/当前受限）', host: 'api.openai.com' },
];

describe('CloudModelsPanelView', () => {
  it('hides provider list when cloud is disabled and states local-only', () => {
    const html = renderToStaticMarkup(
      <CloudModelsPanelView status="ready" enabled={false} providers={[]} available={available} error="" busy={false} onToggleEnabled={noop} onToggleProvider={noop} onRefresh={noop} />,
    );
    expect(html).toContain('云端模型');
    expect(html).toContain('仅本地模型');
    expect(html).toContain('启用');
    expect(html).not.toContain('api.deepseek.com');
  });

  it('lists providers with放行 state when enabled', () => {
    const html = renderToStaticMarkup(
      <CloudModelsPanelView status="ready" enabled={true} providers={['deepseek']} available={available} error="" busy={false} onToggleEnabled={noop} onToggleProvider={noop} onRefresh={noop} />,
    );
    expect(html).toContain('api.deepseek.com');
    expect(html).toContain('api.openai.com');
    expect(html).toContain('已放行');
    expect(html).toContain('放行');
    expect(html).toContain('填该厂商 API key');
  });
});
