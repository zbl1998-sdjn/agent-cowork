import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AuthIdentity } from '../lib/api';
import { AppOverlays } from './AppOverlays';

const user: AuthIdentity = { tenantId: 'tenant-1', userId: 'user-1', username: 'Derrick' };

function renderOverlays(settingsOpen: boolean): string {
  return renderToStaticMarkup(
    <AppOverlays
      cmdkOpen={false}
      commands={[]}
      previewPath={null}
      onboardingOpen={false}
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
    const html = renderOverlays(false);

    expect(html).not.toContain('正在加载设置');
  });

  it('renders a fallback while the settings chunk loads', () => {
    const html = renderOverlays(true);

    expect(html).toContain('正在加载设置');
  });
});
