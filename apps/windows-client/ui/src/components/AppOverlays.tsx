import type { AuthIdentity } from '../lib/api';
import type { Command } from './CommandPalette';
import { CommandPalette } from './CommandPalette';
import { FilePreview } from './FilePreview';
import { Settings } from './Settings';

interface AppOverlaysProps {
  cmdkOpen: boolean;
  commands: Command[];
  previewPath: string | null;
  settingsOpen: boolean;
  theme: 'light' | 'dark';
  trustedRoot: string;
  user: AuthIdentity;
  autoClarify: boolean;
  onCloseCommandPalette: () => void;
  onClosePreview: () => void;
  onCloseSettings: () => void;
  onLogout: () => void;
  onSettingsSaved: (info: { chatEnabled?: boolean; model?: string }) => void;
  onSetAutoClarify: (enabled: boolean) => void;
  onSetTheme: (theme: 'light' | 'dark') => void;
}

export function AppOverlays({
  cmdkOpen,
  commands,
  previewPath,
  settingsOpen,
  theme,
  trustedRoot,
  user,
  autoClarify,
  onCloseCommandPalette,
  onClosePreview,
  onCloseSettings,
  onLogout,
  onSettingsSaved,
  onSetAutoClarify,
  onSetTheme,
}: AppOverlaysProps) {
  return (
    <>
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
