import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AuthIdentity } from '../lib/api';
import { AppOverlays } from './AppOverlays';

const user: AuthIdentity = { tenantId: 'tenant-1', userId: 'user-1', username: 'Derrick' };

function renderOverlays({ settingsOpen = false, onboardingOpen = false } = {}): string {
  return renderToStaticMarkup(
    <AppOverlays
      cmdkOpen={false}
      commands={[]}
      previewPath={null}
      onboardingOpen={onboardingOpen}
      settingsOpen={settingsOpen}
      theme="light"
      trustedRoot="C:/work"
      user={user}
      autoClarify={false}
      onCloseCommandPalette={vi.fn()}
      onCompleteOnboarding={vi.fn()}
      onClosePreview={vi.fn()}
      onCloseSettings={vi.fn()}
      onOpenSettingsFromOnboarding={vi.fn()}
      onLogout={vi.fn()}
      onSettingsSaved={vi.fn()}
      onSetAutoClarify={vi.fn()}
      onSetTheme={vi.fn()}
    />,
  );
}

describe('AppOverlays', () => {
  it('does not render the settings chunk when settings is closed', () => {
    const html = renderOverlays();

    expect(html).not.toContain('正在加载设置');
  });

  it('renders a fallback while the settings chunk loads', () => {
    const html = renderOverlays({ settingsOpen: true });

    expect(html).toContain('正在加载设置');
  });

  it('renders the onboarding overlay when first-run guidance is open', () => {
    const html = renderOverlays({ onboardingOpen: true });

    expect(html).toContain('首启引导');
    expect(html).toContain('先按你的工作方式配一下');
    expect(html).toContain('建议设置');
    expect(html).toContain('配置 Kimi API');
    expect(html).toContain('进入 API 设置');
  });
});
