// useAppRuntimeState(UI · hooks 层)
// ---------------------------------------------------------------------------
// 职责:聚合应用级运行时状态——host 连通性/健康、Kimi 配置、运行时依赖、能力开关等的加载与轮询,
//       为顶层组件提供统一的「环境就绪度」。依赖:lib/api(诊断/配置/依赖)。
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getJson,
  getKimiInfo,
  getMe,
  guestLogin,
  logout as apiLogout,
  type AuthIdentity,
  type KimiInfo,
  type ModelProviderOption,
} from '../lib/api';
import { AUTO_CLARIFY_KEY, AUTO_CONTEXT_COMPACTION_KEY, GUEST_KEY, STARTERS } from '../lib/app-constants';
import { buildContextualStarters } from '../lib/starter-suggestions';
import type { WorkspaceInfo } from '../lib/app-types';
import { ONBOARDING_DONE_KEY } from '../lib/onboarding';
import type { RunSummary } from '../lib/types';
import type { HistoryRun, Recipe } from '../lib/types/composer';
import type { SecurityStatus } from '../lib/types/security';
import type { AppFontFamily, AppFontScale, SettingsTab } from '../lib/types/settings';
import { runtimeDefaultsFromKimiInfo } from './runtime-model-defaults';
export { runtimeDefaultsFromKimiInfo } from './runtime-model-defaults';
const FONT_SCALE_KEY = 'kcw.fontScale';
const FONT_FAMILY_KEY = 'kcw.fontFamily';
const FONT_SCALES = new Set<AppFontScale>(['small', 'normal', 'large', 'xlarge']);
const FONT_FAMILIES = new Set<AppFontFamily>(['system', 'chinese', 'serif', 'mono']);

function readStoredFontScale(): AppFontScale {
  try {
    const value = localStorage.getItem(FONT_SCALE_KEY) as AppFontScale | null;
    return value && FONT_SCALES.has(value) ? value : 'normal';
  } catch {
    return 'normal';
  }
}

function readStoredFontFamily(): AppFontFamily {
  try {
    const value = localStorage.getItem(FONT_FAMILY_KEY) as AppFontFamily | null;
    return value && FONT_FAMILIES.has(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function historyRunsFromIndex(runs: RunSummary[] = []): HistoryRun[] {
  return runs.map((run) => ({ id: run.id, promptPreview: run.promptPreview }));
}

export function runtimeStarters(recipes: Recipe[] = [], historyRuns: HistoryRun[] = []): string[] {
  return buildContextualStarters({ base: STARTERS, recipes, historyRuns });
}

export function useAppRuntimeState() {
  const [trustedRoot, setTrustedRoot] = useState('');
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [history, setHistory] = useState<HistoryRun[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [modelProviders, setModelProviders] = useState<ModelProviderOption[]>([]);
  const [defaultModel, setDefaultModel] = useState('');
  const [defaultProvider, setDefaultProvider] = useState('kimi-api');
  const [defaultBaseUrl, setDefaultBaseUrl] = useState('');
  const [securityStatus, setSecurityStatus] = useState<SecurityStatus | null>(null);
  const [chatEnabled, setChatEnabled] = useState(false);
  const [autoClarify, setAutoClarify] = useState(() => {
    try { return localStorage.getItem(AUTO_CLARIFY_KEY) === '1'; } catch { return false; }
  });
  const [autoContextCompaction, setAutoContextCompaction] = useState(() => {
    try {
      const value = localStorage.getItem(AUTO_CONTEXT_COMPACTION_KEY);
      return value == null ? true : value === '1';
    } catch { return true; }
  });
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try { return localStorage.getItem('kcw.theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
  });
  const [fontScale, setFontScale] = useState<AppFontScale>(() => readStoredFontScale());
  const [fontFamily, setFontFamily] = useState<AppFontFamily>(() => readStoredFontFamily());
  const [user, setUser] = useState<AuthIdentity | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('account');
  const [onboardingOpen, setOnboardingOpen] = useState(() => {
    try { return localStorage.getItem(ONBOARDING_DONE_KEY) !== '1'; } catch { return true; }
  });
  const starters = useMemo(() => runtimeStarters(recipes, history), [recipes, history]);

  const applyKimiInfo = useCallback((info: Partial<KimiInfo> | null | undefined) => {
    const defaults = runtimeDefaultsFromKimiInfo(info);
    setChatEnabled(defaults.chatEnabled);
    setDefaultProvider(defaults.provider);
    setDefaultBaseUrl(defaults.baseUrl);
    setModelProviders(defaults.providers);
    if (defaults.model) {
      setDefaultModel(defaults.model);
      setModels(defaults.models);
    }
  }, []);
  const upsertRecipe = useCallback((recipe: Recipe) => {
    setRecipes((current) => (current.some((item) => item.id === recipe.id)
      ? current.map((item) => (item.id === recipe.id ? recipe : item))
      : [recipe, ...current]));
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const me = await getMe();
        if (me) setUser(me);
        else if (localStorage.getItem(GUEST_KEY) === '1') {
          const guest = await guestLogin();
          if (guest) setUser(guest);
        }
      } catch { /* host 未就绪时停留在登录门面 */ }
      finally { setAuthReady(true); }
    })();
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('kcw.theme', theme); } catch { /* 本地存储不可用时只保留内存状态 */ }
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-font-scale', fontScale);
    try { localStorage.setItem(FONT_SCALE_KEY, fontScale); } catch { /* 本地存储不可用时只保留内存状态 */ }
  }, [fontScale]);

  useEffect(() => {
    document.documentElement.setAttribute('data-font-family', fontFamily);
    try { localStorage.setItem(FONT_FAMILY_KEY, fontFamily); } catch { /* 本地存储不可用时只保留内存状态 */ }
  }, [fontFamily]);

  useEffect(() => {
    try { localStorage.setItem(AUTO_CLARIFY_KEY, autoClarify ? '1' : '0'); } catch { /* 本地存储不可用时只保留内存状态 */ }
  }, [autoClarify]);

  useEffect(() => {
    try { localStorage.setItem(AUTO_CONTEXT_COMPACTION_KEY, autoContextCompaction ? '1' : '0'); } catch { /* 本地存储不可用时只保留内存状态 */ }
  }, [autoContextCompaction]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setCmdkOpen((value) => !value); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      try {
        const workspace = await getJson<WorkspaceInfo>('/api/workspace');
        setTrustedRoot(workspace.trustedRoot);
      } catch { /* host 未就绪时先留空工作区 */ }
      try {
        const response = await getJson<{ recipes: Recipe[] }>('/api/recipes');
        setRecipes(response.recipes || []);
      } catch { /* 配方加载失败不阻断主界面 */ }
      try {
        const index = await getJson<{ runs: RunSummary[] }>('/api/runs/index');
        setHistory(historyRunsFromIndex(index.runs || []));
      } catch { /* 运行历史加载失败不阻断主界面 */ }
      try {
        applyKimiInfo(await getKimiInfo());
      } catch { /* 模型配置加载失败不阻断主界面 */ }
      try {
        setSecurityStatus(await getJson<SecurityStatus>('/api/security/status'));
      } catch { /* 安全状态加载失败不阻断主界面 */ }
    })();
  }, [applyKimiInfo, user]);

  const doLogout = useCallback(async () => {
    try { await apiLogout(); } catch { /* 登出尽力而为,本地仍会清掉身份 */ }
    try { localStorage.removeItem(GUEST_KEY); } catch { /* 本地存储不可用时忽略 */ }
    setUser(null);
  }, []);

  const completeOnboarding = useCallback(() => {
    try { localStorage.setItem(ONBOARDING_DONE_KEY, '1'); } catch { /* 本地存储不可用时忽略 */ }
    setOnboardingOpen(false);
  }, []);

  const openSettings = useCallback((tab: SettingsTab = 'account') => {
    setSettingsInitialTab(tab);
    setSettingsOpen(true);
  }, []);

  const openSettingsFromOnboarding = useCallback(() => {
    completeOnboarding();
    openSettings('account');
  }, [completeOnboarding, openSettings]);

  const openSettingsTabFromOnboarding = useCallback((tab: SettingsTab) => {
    completeOnboarding();
    openSettings(tab);
  }, [completeOnboarding, openSettings]);

  const continueAsGuest = useCallback(() => {
    try { localStorage.setItem(GUEST_KEY, '1'); } catch { /* 本地存储不可用时忽略 */ }
    void (async () => {
      const guest = await guestLogin();
      if (guest) setUser(guest);
    })();
  }, []);

  const toggleTheme = useCallback(() => setTheme((value) => (value === 'dark' ? 'light' : 'dark')), []);

  return {
    applyKimiInfo,
    authReady,
    autoClarify,
    autoContextCompaction,
    chatEnabled,
    closeSettings: () => setSettingsOpen(false),
    cmdkOpen,
    completeOnboarding,
    continueAsGuest,
    defaultBaseUrl,
    defaultModel,
    defaultProvider,
    doLogout,
    fontFamily,
    fontScale,
    handleAuthed: setUser,
    history,
    models,
    modelProviders,
    onboardingOpen,
    openSettings,
    openSettingsFromOnboarding,
    openSettingsTabFromOnboarding,
    recipes,
    setAutoClarify,
    setAutoContextCompaction,
    setChatEnabled,
    setCmdkOpen,
    setFontFamily,
    setFontScale,
    setTheme,
    securityStatus,
    settingsInitialTab,
    settingsOpen,
    starters,
    theme,
    toggleTheme,
    trustedRoot,
    upsertRecipe,
    user,
  };
}
