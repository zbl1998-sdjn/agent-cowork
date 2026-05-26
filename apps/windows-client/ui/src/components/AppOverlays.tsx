import { lazy, Suspense } from 'react';
import type { AuthIdentity, KimiInfo } from '../lib/api';
import type { Command } from './CommandPalette';
import { CommandPalette } from './CommandPalette';
import { FilePreview } from './FilePreview';
import { OnboardingPanel } from './overlays/OnboardingPanel';
import type { SettingsTab } from './Settings';
import { Loading } from './ui/StateViews';

const Settings = lazy(() => import('./Settings').then((module) => ({ default: module.Settings })));

interface AppOverlaysProps {
  cmdkOpen: boolean;
  commands: Command[];
  previewPath: string | null;
  onboardingOpen: boolean;
  settingsOpen: boolean;
  settingsInitialTab?: SettingsTab;
  theme: 'light' | 'dark';
  trustedRoot: string;
  user: AuthIdentity;
  autoClarify: boolean;
  onCloseCommandPalette: () => void;
  onCompleteOnboarding: () => void;
  onClosePreview: () => void;
  onCloseSettings: () => void;
  onOpenSettingsFromOnboarding: () => void;
  onOpenSettingsTabFromOnboarding?: (tab: SettingsTab) => void;
  onLogout: () => void;
  onSettingsSaved: (info: KimiInfo) => void;
  onSetAutoClarify: (enabled: boolean) => void;
  onSetTheme: (theme: 'light' | 'dark') => void;
}

export function AppOverlays({
  cmdkOpen,
  commands,
  previewPath,
  onboardingOpen,
  settingsOpen,
  settingsInitialTab = 'account',
  theme,
  trustedRoot,
  user,
  autoClarify,
  onCloseCommandPalette,
  onCompleteOnboarding,
  onClosePreview,
  onCloseSettings,
  onOpenSettingsFromOnboarding,
  onOpenSettingsTabFromOnboarding,
  onLogout,
  onSettingsSaved,
  onSetAutoClarify,
  onSetTheme,
}: AppOverlaysProps) {
  return (
    <>
      {onboardingOpen && (
        <OnboardingPanel
          workspaceType={trustedRoot ? 'workspace' : 'local'}
          onComplete={onCompleteOnboarding}
          onOpenSettings={onOpenSettingsFromOnboarding}
          onOpenSettingsTab={onOpenSettingsTabFromOnboarding}
        />
      )}
      {cmdkOpen && <CommandPalette commands={commands} onClose={onCloseCommandPalette} />}
      {previewPath && <FilePreview path={previewPath} trustedRoot={trustedRoot} onClose={onClosePreview} />}
      {settingsOpen && (
        <Suspense fallback={<Loading message="正在加载设置…" />}>
          <Settings
            initialTab={settingsInitialTab}
            username={user.username}
            tenantId={user.tenantId}
            theme={theme}
            autoClarify={autoClarify}
            onSetAutoClarify={onSetAutoClarify}
            onSetTheme={onSetTheme}
            onLogout={onLogout}
            onClose={onCloseSettings}
            onSaved={onSettingsSaved}
          />
        </Suspense>
      )}
    </>
  );
}
