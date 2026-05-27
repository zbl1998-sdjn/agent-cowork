import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getJson,
  getKimiInfo,
  getMe,
  guestLogin,
  logout as apiLogout,
  type AuthIdentity,
  type KimiInfo,
} from '../lib/api';
import { AUTO_CLARIFY_KEY, GUEST_KEY, STARTERS } from '../lib/app-constants';
import { buildContextualStarters } from '../lib/starter-suggestions';
import type { WorkspaceInfo } from '../lib/app-types';
import { ONBOARDING_DONE_KEY } from '../lib/onboarding';
import type { RunSummary } from '../lib/types';
import type { HistoryRun, Recipe } from '../components/Composer';
import type { SettingsTab } from '../components/Settings';

interface RuntimeDefaults {
  chatEnabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  models: string[];
}

export function runtimeDefaultsFromKimiInfo(info: Partial<KimiInfo> | null | undefined): RuntimeDefaults {
  const model = info?.model || '';
  return {
    chatEnabled: Boolean(info?.chatEnabled),
    provider: info?.provider || 'kimi-api',
    baseUrl: info?.baseUrl || '',
    model,
    models: model ? [model] : [],
  };
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
  const [defaultModel, setDefaultModel] = useState('');
  const [defaultProvider, setDefaultProvider] = useState('kimi-api');
  const [defaultBaseUrl, setDefaultBaseUrl] = useState('');
  const [chatEnabled, setChatEnabled] = useState(false);
  const [autoClarify, setAutoClarify] = useState(() => {
    try { return localStorage.getItem(AUTO_CLARIFY_KEY) === '1'; } catch { return false; }
  });
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try { return localStorage.getItem('kcw.theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
  });
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
      } catch { /* host not ready -> stay on gate */ }
      finally { setAuthReady(true); }
    })();
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('kcw.theme', theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    try { localStorage.setItem(AUTO_CLARIFY_KEY, autoClarify ? '1' : '0'); } catch { /* ignore */ }
  }, [autoClarify]);

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
      } catch { /* host not ready */ }
      try {
        const response = await getJson<{ recipes: Recipe[] }>('/api/recipes');
        setRecipes(response.recipes || []);
      } catch { /* ignore */ }
      try {
        const index = await getJson<{ runs: RunSummary[] }>('/api/runs/index');
        setHistory(historyRunsFromIndex(index.runs || []));
      } catch { /* ignore */ }
      try {
        applyKimiInfo(await getKimiInfo());
      } catch { /* ignore */ }
    })();
  }, [applyKimiInfo, user]);

  const doLogout = useCallback(async () => {
    try { await apiLogout(); } catch { /* best-effort */ }
    try { localStorage.removeItem(GUEST_KEY); } catch { /* ignore */ }
    setUser(null);
  }, []);

  const completeOnboarding = useCallback(() => {
    try { localStorage.setItem(ONBOARDING_DONE_KEY, '1'); } catch { /* ignore */ }
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
    try { localStorage.setItem(GUEST_KEY, '1'); } catch { /* ignore */ }
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
    chatEnabled,
    closeSettings: () => setSettingsOpen(false),
    cmdkOpen,
    completeOnboarding,
    continueAsGuest,
    defaultBaseUrl,
    defaultModel,
    defaultProvider,
    doLogout,
    handleAuthed: setUser,
    history,
    models,
    onboardingOpen,
    openSettings,
    openSettingsFromOnboarding,
    openSettingsTabFromOnboarding,
    recipes,
    setAutoClarify,
    setChatEnabled,
    setCmdkOpen,
    setTheme,
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
