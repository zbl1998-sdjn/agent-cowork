// Settings(UI · components):设置模态外框——管理标签切换与保存,内容由 SettingsTabsContent 承载。纯展示+回调。
import { useEffect, useState } from 'react';
import { getAgentEngineInfo, saveAgentEngineConfig, getSelfCheck, type AgentEngineInfo, type ModelProviderOption, type SelfCheckResult } from '../lib/api';
import { humanizeError } from '../lib/friendly-error';
import { IconButton } from './ui/Button';
import { SegmentedControl } from './ui/SegmentedControl';
import { SettingsTabsContent, type SettingsPersistPayload } from './SettingsTabsContent';
import type { AppFontFamily, AppFontScale, SettingsTab } from './settings-types';

// 再导出 SettingsTab,让 App.tsx/Settings.test.tsx 的旧 import path 不变。
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
  fontScale: AppFontScale;
  fontFamily: AppFontFamily;
  autoClarify: boolean;
  autoContextCompaction: boolean;
  onSetAutoClarify: (enabled: boolean) => void;
  onSetAutoContextCompaction: (enabled: boolean) => void;
  onSetTheme: (t: 'light' | 'dark') => void;
  onSetFontScale: (scale: AppFontScale) => void;
  onSetFontFamily: (family: AppFontFamily) => void;
  onLogout: () => void;
  onClose: () => void;
  onSaved: (info: AgentEngineInfo) => void;
}

// 统一设置中心:账户/外观/模型/API/健康检查在一个模态框里。
// API key 只展示 hasKey 标记,绝不回显;保存空 key 会保留原 key。
// 模态框状态与持久化留在此处,各标签正文放进 SettingsTabsContent 以控制文件体量。
export function Settings({ initialTab = 'account', username, tenantId, theme, fontScale, fontFamily, autoClarify, autoContextCompaction, onSetAutoClarify, onSetAutoContextCompaction, onSetTheme, onSetFontScale, onSetFontFamily, onLogout, onClose, onSaved }: SettingsProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState('kimi-api');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [providers, setProviders] = useState<ModelProviderOption[]>([]);
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
        const info = await getAgentEngineInfo();
        setProvider(info.provider || 'kimi-api');
        setBaseUrl(info.baseUrl || '');
        setModel(info.model || '');
        setProviders(info.providers || []);
        setHasKey(Boolean(info.hasKey));
      } catch {
        /* host 未就绪时保持默认值 */
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

  // 打开健康检查标签时加载或刷新 self-check。
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
        const info = await saveAgentEngineConfig(payload);
        setHasKey(Boolean(info.hasKey));
        setProvider(info.provider || provider);
        setBaseUrl(info.baseUrl || '');
        setModel(info.model || '');
        setProviders(info.providers || providers);
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
            fontScale={fontScale} onSetFontScale={onSetFontScale}
            fontFamily={fontFamily} onSetFontFamily={onSetFontFamily}
            autoClarify={autoClarify} onSetAutoClarify={onSetAutoClarify}
            autoContextCompaction={autoContextCompaction} onSetAutoContextCompaction={onSetAutoContextCompaction}
            provider={provider} setProvider={setProvider}
            providers={providers}
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
