import type { AuthIdentity, KimiInfo } from '../lib/api';
import type { Command } from './CommandPalette';
import { CommandPalette } from './CommandPalette';
import { FilePreview } from './FilePreview';
import { OnboardingPanel } from './OnboardingPanel';
import { Settings } from './Settings';

interface AppOverlaysProps {
  cmdkOpen: boolean;
  commands: Command[];
  previewPath: string | null;
  onboardingOpen: boolean;
  settingsOpen: boolean;
  theme: 'light' | 'dark';
  trustedRoot: string;
  user: AuthIdentity;
  autoClarify: boolean;
  onCloseCommandPalette: () => void;
  onCompleteOnboarding: () => void;
  onClosePreview: () => void;
  onCloseSettings: () => void;
  onOpenSettingsFromOnboarding: () => void;
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
  theme,
  trustedRoot,
  user,
  autoClarify,
  onCloseCommandPalette,
  onCompleteOnboarding,
  onClosePreview,
  onCloseSettings,
  onOpenSettingsFromOnboarding,
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
        />
      )}
      {cmdkOpen && <CommandPalette commands={commands} onClose={onCloseCommandPalette} />}
      {previewPath && <FilePreview path={previewPath} trustedRoot={trustedRoot} onClose={onClosePreview} />}
      {settingsOpen && (
        <Settings
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
      )}
    </>
  );
}
