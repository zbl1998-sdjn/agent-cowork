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

    expect(html).toContain('class="is-active">API</button>');
    expect(html).toContain('加载中');
    expect(html).not.toContain('用户名');
  });

  it('opens on the requested self-check tab', () => {
    const html = renderSettings('selfcheck');

    expect(html).toContain('class="is-active">自检</button>');
    expect(html).toContain('安全 / 韧性自检');
    expect(html).not.toContain('用户名');
  });
});
