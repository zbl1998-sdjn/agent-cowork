// 应用级浮层聚合(UI · 组件层 · components)
// ---------------------------------------------------------------------------
// 职责:集中按显隐标志挂载引导、命令面板、文件预览与设置(lazy)等模态;只负责显隐编排,自身不取数据。
// 依赖:CommandPalette、FilePreview、OnboardingPanel、懒加载的 Settings、Loading。
import { lazy, Suspense } from 'react';
import type { AuthIdentity, AgentEngineInfo } from '../lib/api';
import type { Command } from './CommandPalette';
import { CommandPalette } from './CommandPalette';
import { FilePreview } from './FilePreview';
import { OnboardingPanel } from './overlays/OnboardingPanel';
import type { SettingsTab } from './Settings';
import type { AppFontFamily, AppFontScale } from './settings-types';
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
  fontScale: AppFontScale;
  fontFamily: AppFontFamily;
  trustedRoot: string;
  user: AuthIdentity;
  autoClarify: boolean;
  autoContextCompaction: boolean;
  onCloseCommandPalette: () => void;
  onCompleteOnboarding: () => void;
  onClosePreview: () => void;
  onCloseSettings: () => void;
  onOpenSettingsFromOnboarding: () => void;
  onOpenSettingsTabFromOnboarding?: (tab: SettingsTab) => void;
  onLogout: () => void;
  onSettingsSaved: (info: AgentEngineInfo) => void;
  onSetAutoClarify: (enabled: boolean) => void;
  onSetAutoContextCompaction: (enabled: boolean) => void;
  onSetTheme: (theme: 'light' | 'dark') => void;
  onSetFontScale: (scale: AppFontScale) => void;
  onSetFontFamily: (family: AppFontFamily) => void;
}

export function AppOverlays({
  cmdkOpen,
  commands,
  previewPath,
  onboardingOpen,
  settingsOpen,
  settingsInitialTab = 'account',
  theme,
  fontScale,
  fontFamily,
  trustedRoot,
  user,
  autoClarify,
  autoContextCompaction,
  onCloseCommandPalette,
  onCompleteOnboarding,
  onClosePreview,
  onCloseSettings,
  onOpenSettingsFromOnboarding,
  onOpenSettingsTabFromOnboarding,
  onLogout,
  onSettingsSaved,
  onSetAutoClarify,
  onSetAutoContextCompaction,
  onSetTheme,
  onSetFontScale,
  onSetFontFamily,
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
            fontScale={fontScale}
            fontFamily={fontFamily}
            autoClarify={autoClarify}
            autoContextCompaction={autoContextCompaction}
            onSetAutoClarify={onSetAutoClarify}
            onSetAutoContextCompaction={onSetAutoContextCompaction}
            onSetTheme={onSetTheme}
            onSetFontScale={onSetFontScale}
            onSetFontFamily={onSetFontFamily}
            onLogout={onLogout}
            onClose={onCloseSettings}
            onSaved={onSettingsSaved}
          />
        </Suspense>
      )}
    </>
  );
}
