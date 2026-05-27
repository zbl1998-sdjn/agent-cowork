import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Settings, type SettingsTab } from './Settings';

function renderSettings(initialTab: SettingsTab): string {
  return renderToStaticMarkup(
    <Settings
      initialTab={initialTab}
      username="Derrick"
      tenantId="tenant-1"
      theme="light"
      autoClarify={false}
      onSetAutoClarify={vi.fn()}
      onSetTheme={vi.fn()}
      onLogout={vi.fn()}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
}

describe('Settings', () => {
  it('opens on the requested API tab', () => {
    const html = renderSettings('api');

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('ui-btn ui-btn--ghost ui-btn--md is-active');
    expect(html).toContain('>API</button>');
    expect(html).toContain('加载中');
    expect(html).toContain('ui-icon-btn modal-close');
    expect(html).not.toContain('用户名');
  });

  it('opens on the requested self-check tab', () => {
    const html = renderSettings('selfcheck');

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('>自检</button>');
    expect(html).toContain('安全 / 韧性自检');
    expect(html).toContain('ui-btn ui-btn--secondary');
    expect(html).not.toContain('用户名');
  });

  it('opens on the desktop updates tab', () => {
    const html = renderSettings('updates');

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('>更新</button>');
    expect(html).toContain('正在加载更新状态');
    expect(html).not.toContain('用户名');
  });

  it('renders settings segmented controls through the shared primitive', () => {
    const appearance = renderSettings('appearance');
    const input = renderSettings('input');

    expect(appearance).toContain('role="group"');
    expect(appearance).toContain('aria-label="主题"');
    expect(appearance).toContain('aria-pressed="true"');
    expect(input).toContain('aria-label="发送前澄清"');
    expect(input).toContain('>关闭</button>');
  });
});
