import { useEffect, useState } from 'react';
import { getKimiInfo, saveKimiConfig, getSelfCheck, type KimiInfo, type SelfCheckResult } from '../lib/api';
import { humanizeError } from '../lib/friendly-error';
import { IconButton } from './ui/Button';
import { SegmentedControl } from './ui/SegmentedControl';
import { SettingsTabsContent, type SettingsPersistPayload } from './SettingsTabsContent';
import type { SettingsTab } from './settings-types';

// Re-exported so existing callers (App.tsx, Settings.test.tsx) keep their
// import paths working unchanged (we just rehomed the type to settings-types).
export type { SettingsTab } from './settings-types';

const SETTINGS_TABS: Array<{ value: SettingsTab; label: string }> = [
  { value: 'account', label: '账户' },
  { value: 'appearance', label: '外观' },
  { value: 'model', label: '默认模型' },
  { value: 'input', label: '输入助手' },
  { value: 'api', label: '密钥' },
  { value: 'runtime', label: '组件' },
  { value: 'updates', label: '更新' },
  { value: 'selfcheck', label: '健康检查' },
];

interface SettingsProps {
  initialTab?: SettingsTab;
  username: string;
  tenantId: string;
  theme: 'light' | 'dark';
  autoClarify: boolean;
  onSetAutoClarify: (enabled: boolean) => void;
  onSetTheme: (t: 'light' | 'dark') => void;
  onLogout: () => void;
  onClose: () => void;
  onSaved: (info: KimiInfo) => void;
}

// Unified settings center (kimi.exe style): account / appearance / model / API /
// self-check tabs in one modal. The API key is shown only as a `hasKey` flag and
// never echoed back; saving an empty key keeps the existing one.
//
// Modal frame + state + persistence live here; per-tab body markup lives in
// SettingsTabsContent so each file stays under the file-size soft limit.
export function Settings({ initialTab = 'account', username, tenantId, theme, autoClarify, onSetAutoClarify, onSetTheme, onLogout, onClose, onSaved }: SettingsProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState('kimi-api');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedTip, setSavedTip] = useState('');
  const [selfCheck, setSelfCheck] = useState<SelfCheckResult | null>(null);
  const [scError, setScError] = useState('');
  const [scLoading, setScLoading] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const info = await getKimiInfo();
        setProvider(info.provider || 'kimi-api');
        setBaseUrl(info.baseUrl || '');
        setModel(info.model || '');
        setHasKey(Boolean(info.hasKey));
      } catch {
        /* host not ready */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  // Load (or refresh) the self-check whenever its tab is opened.
  const loadSelfCheck = () => {
    setScLoading(true); setScError('');
    getSelfCheck()
      .then((r) => setSelfCheck(r))
      .catch((e) => setScError(humanizeError(e, { action: '健康检查' })))
      .finally(() => setScLoading(false));
  };
  useEffect(() => {
    if (tab === 'selfcheck' && !selfCheck && !scLoading) loadSelfCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const persist = (payload: SettingsPersistPayload, okMsg: string) => {
    if (busy) return;
    setBusy(true); setError(''); setSavedTip('');
    void (async () => {
      try {
        const info = await saveKimiConfig(payload);
        setHasKey(Boolean(info.hasKey));
        setApiKey('');
        onSaved(info);
        setSavedTip(okMsg);
        setTimeout(() => setSavedTip(''), 2500);
      } catch (err) {
        setError(humanizeError(err, { action: '保存' }));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card settings-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="设置">
        <header className="modal-head">
          <h2>设置</h2>
          <IconButton className="modal-close" label="关闭" onClick={onClose}>×</IconButton>
        </header>
        <div className="settings-body">
          <nav><SegmentedControl ariaLabel="设置分区" className="settings-tabs" variant="sidebar" value={tab} options={SETTINGS_TABS} onChange={setTab} /></nav>
          <SettingsTabsContent
            tab={tab}
            username={username} tenantId={tenantId} onLogout={onLogout}
            theme={theme} onSetTheme={onSetTheme}
            autoClarify={autoClarify} onSetAutoClarify={onSetAutoClarify}
            provider={provider} setProvider={setProvider}
            model={model} setModel={setModel}
            baseUrl={baseUrl} setBaseUrl={setBaseUrl}
            apiKey={apiKey} setApiKey={setApiKey}
            hasKey={hasKey} loading={loading} busy={busy} persist={persist}
            selfCheck={selfCheck} scError={scError} scLoading={scLoading}
            onRefreshSelfCheck={loadSelfCheck}
            error={error} savedTip={savedTip}
          />
        </div>
      </div>
    </div>
  );
}
