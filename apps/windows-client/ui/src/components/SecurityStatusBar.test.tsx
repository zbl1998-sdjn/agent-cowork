import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SecurityStatusBar } from './SecurityStatusBar';

describe('SecurityStatusBar', () => {
  it('states the cloud boundary plainly and hides technical details by default', () => {
    const html = renderToStaticMarkup(
      <SecurityStatusBar status={{
        securityMode: 'controlled_hybrid',
        model: { provider: 'kimi-api', model: 'kimi-k2.7-code', providerClass: 'external_provider' },
        egress: { todayContentBytes: 0, todayExternalModelCalls: 0, deniedCount: 0 },
      }} />,
    );

    expect(html).toContain('使用云端模型');
    expect(html).toContain('今天未记录外发内容');
    expect(html).toContain('<summary>技术详情</summary>');
    expect(html).toContain('保护模式：受控混合');
    expect(html).toContain('使用模型：kimi-api / kimi-k2.7-code');
    expect(html).not.toContain('<span>外发 0 B</span>');
  });

  it('states when content has been sent to the selected model', () => {
    const html = renderToStaticMarkup(
      <SecurityStatusBar status={{
        securityMode: 'local_strict',
        model: { provider: 'ollama', model: 'qwen3', providerClass: 'local' },
        egress: { todayContentBytes: 1536, todayExternalModelCalls: 1, deniedCount: 2 },
      }} />,
    );

    expect(html).toContain('仅本地处理');
    expect(html).toContain('今天已记录外发内容 1.5 KB · 外部模型 1 次');
    expect(html).toContain('外部模型调用：1 次');
    expect(html).toContain('已阻止：2 次');
  });
});
