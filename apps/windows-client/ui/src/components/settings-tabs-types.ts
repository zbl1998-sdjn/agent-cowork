import type {
  ModelConnectionResult,
  ModelProviderOption,
  ModelProviderRuntimeState,
  SelfCheckResult,
} from '../lib/api';
import type { AppFontFamily, AppFontScale, SettingsTab } from './settings-types';

export interface SettingsPersistPayload {
  provider?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  clearKey?: boolean | undefined;
}

export interface SettingsTabsContentProps {
  tab: SettingsTab;
  username: string;
  tenantId: string;
  onLogout: () => void;
  theme: 'light' | 'dark';
  onSetTheme: (theme: 'light' | 'dark') => void;
  fontScale: AppFontScale;
  onSetFontScale: (scale: AppFontScale) => void;
  fontFamily: AppFontFamily;
  onSetFontFamily: (family: AppFontFamily) => void;
  autoClarify: boolean;
  onSetAutoClarify: (enabled: boolean) => void;
  autoContextCompaction: boolean;
  onSetAutoContextCompaction: (enabled: boolean) => void;
  provider: string;
  setProvider: (value: string) => void;
  providers?: ModelProviderOption[];
  model: string;
  setModel: (value: string) => void;
  baseUrl: string;
  setBaseUrl: (value: string) => void;
  apiKey: string;
  setApiKey: (value: string) => void;
  hasKey: boolean;
  setHasKey: (value: boolean) => void;
  providerStates: ModelProviderRuntimeState[];
  availableModels: string[];
  connection: ModelConnectionResult | null;
  testingConnection: boolean;
  onTestConnection: () => void;
  onProviderSelected?: (provider: string) => void;
  loading: boolean;
  busy: boolean;
  persist: (payload: SettingsPersistPayload, okMsg: string) => void;
  selfCheck: SelfCheckResult | null;
  scError: string;
  scLoading: boolean;
  onRefreshSelfCheck: () => void;
  error: string;
  savedTip: string;
}
