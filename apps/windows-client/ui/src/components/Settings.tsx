import { useEffect, useState } from 'react';
import { getKimiInfo, saveKimiConfig, getSelfCheck, type KimiInfo, type SelfCheckResult } from '../lib/api';
import { RuntimeDependenciesPanel } from './RuntimeDependenciesPanel';

type Tab = 'account' | 'appearance' | 'model' | 'input' | 'api' | 'runtime' | 'selfcheck';

const MODEL_PROVIDERS = [
  { value: 'kimi-api', label: 'Kimi' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Claude' },
  { value: 'openai/local', label: '本地 OpenAI-compatible' },
];

interface SettingsProps {
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
export function Settings({ username, tenantId, theme, autoClarify, onSetAutoClarify, onSetTheme, onLogout, onClose, onSaved }: SettingsProps) {
  const [tab, setTab] = useState<Tab>('account');
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

  // Load (or refresh) the self-check whenever its tab is opened.
  const loadSelfCheck = () => {
    setScLoading(true); setScError('');
    getSelfCheck()
      .then((r) => setSelfCheck(r))
      .catch((e) => setScError((e as Error).message || '自检失败'))
      .finally(() => setScLoading(false));
  };
  useEffect(() => {
    if (tab === 'selfcheck' && !selfCheck && !scLoading) loadSelfCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const persist = async (
    payload: { provider?: string; apiKey?: string; baseUrl?: string; model?: string; clearKey?: boolean },
    okMsg: string,
  ) => {
    if (busy) return;
    setBusy(true); setError(''); setSavedTip('');
    try {
      const info = await saveKimiConfig(payload);
      setHasKey(Boolean(info.hasKey));
      setApiKey('');
      onSaved(info);
      setSavedTip(okMsg);
      setTimeout(() => setSavedTip(''), 2500);
    } catch (err) {
      setError((err as Error).message || '保存失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card settings-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="设置">
        <header className="modal-head">
          <h2>设置</h2>
          <button type="button" className="modal-close" aria-label="关闭" onClick={onClose}>×</button>
        </header>
        <div className="settings-body">
          <nav className="settings-tabs">
            <button type="button" className={tab === 'account' ? 'is-active' : ''} onClick={() => setTab('account')}>账户</button>
            <button type="button" className={tab === 'appearance' ? 'is-active' : ''} onClick={() => setTab('appearance')}>外观</button>
            <button type="button" className={tab === 'model' ? 'is-active' : ''} onClick={() => setTab('model')}>模型</button>
            <button type="button" className={tab === 'input' ? 'is-active' : ''} onClick={() => setTab('input')}>输入</button>
            <button type="button" className={tab === 'api' ? 'is-active' : ''} onClick={() => setTab('api')}>API</button>
            <button type="button" className={tab === 'runtime' ? 'is-active' : ''} onClick={() => setTab('runtime')}>运行时</button>
            <button type="button" className={tab === 'selfcheck' ? 'is-active' : ''} onClick={() => setTab('selfcheck')}>自检</button>
          </nav>
          <section className="settings-pane">
            {tab === 'account' && (
              <div>
                <div className="set-row"><span className="set-label">用户名</span><span className="set-val">{username}</span></div>
                <div className="set-row"><span className="set-label">租户</span><span className="set-val">{tenantId}</span></div>
                <button type="button" className="btn-secondary" onClick={onLogout}>退出登录</button>
              </div>
            )}
            {tab === 'appearance' && (
              <div className="set-row">
                <span className="set-label">主题</span>
                <div className="seg">
                  <button type="button" className={theme === 'light' ? 'is-active' : ''} onClick={() => onSetTheme('light')}>浅色</button>
                  <button type="button" className={theme === 'dark' ? 'is-active' : ''} onClick={() => onSetTheme('dark')}>深色</button>
                </div>
              </div>
            )}
            {tab === 'model' && (
              <div>
                <label className="auth-field">
                  <span>默认提供商</span>
                  <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                    {MODEL_PROVIDERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </label>
                <label className="auth-field">
                  <span>默认模型</span>
                  <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="kimi-k2-0905-preview" />
                </label>
                <div className="modal-actions">
                  <span className="modal-actions-spacer" />
                  <button type="button" className="btn-primary" disabled={busy} onClick={() => void persist({ provider, model: model.trim() || undefined }, '模型已保存')}>保存</button>
                </div>
              </div>
            )}
            {tab === 'input' && (
              <div className="set-row">
                <span className="set-label">发送前澄清</span>
                <div className="seg">
                  <button type="button" className={!autoClarify ? 'is-active' : ''} onClick={() => onSetAutoClarify(false)}>关闭</button>
                  <button type="button" className={autoClarify ? 'is-active' : ''} onClick={() => onSetAutoClarify(true)}>开启</button>
                </div>
              </div>
            )}
            {tab === 'api' && (
              loading ? <div className="modal-loading">加载中…</div> : (
                <div>
                  <label className="auth-field">
                    <span>API Key {hasKey && <em className="key-set">已配置</em>}</span>
                    <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={hasKey ? '已配置（留空保持不变）' : 'sk-...'} autoComplete="off" />
                  </label>
                  <label className="auth-field">
                    <span>Base URL</span>
                    <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.moonshot.cn/v1" />
                  </label>
                  <div className="modal-actions">
                    {hasKey && <button type="button" className="btn-ghost-danger" disabled={busy} onClick={() => void persist({ clearKey: true }, '密钥已清除')}>清除密钥</button>}
                    <span className="modal-actions-spacer" />
                    <button type="button" className="btn-primary" disabled={busy} onClick={() => void persist({ provider, apiKey: apiKey.trim() || undefined, baseUrl: baseUrl.trim() || undefined }, '已保存')}>保存</button>
                  </div>
                  <p className="modal-note">密钥仅保存在本机 .AgentCowork/config.json，绝不回传或显示明文。</p>
                </div>
              )
            )}
            {tab === 'runtime' && <RuntimeDependenciesPanel />}
            {tab === 'selfcheck' && (
              <div className="selfcheck">
                <div className="selfcheck-head">
                  <span className="set-label">安全 / 韧性自检</span>
                  <button type="button" className="btn-secondary" disabled={scLoading} onClick={loadSelfCheck}>{scLoading ? '检测中…' : '刷新'}</button>
                </div>
                {scError && <div className="auth-error" role="alert">{scError}</div>}
                {selfCheck && (
                  <>
                    <ul className="selfcheck-list">
                      {selfCheck.checks.map((c) => (
                        <li key={c.id} className={`sc-item sc-${c.status}`}>
                          <span className="sc-dot" aria-hidden="true" />
                          <span className="sc-id">{c.id}</span>
                          <span className="sc-detail">{c.detail}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="modal-note">
                      存储后端：{selfCheck.storage.backend}{selfCheck.storage.postgres ? '（多实例）' : ''} ·
                      沙箱 {selfCheck.sandbox.backend || '关闭'}（{selfCheck.sandbox.networkIsolated ? '网络已隔离' : '本地不隔离网络'}） ·
                      并发 {selfCheck.resilience.concurrency.active}/{selfCheck.resilience.concurrency.maxConcurrent} ·
                      限流 {selfCheck.resilience.rateLimit.enabled ? `${selfCheck.resilience.rateLimit.ratePerSec}/s` : '关'}
                    </p>
                  </>
                )}
              </div>
            )}
            {error && <div className="auth-error" role="alert">{error}</div>}
            {savedTip && <div className="saved-tip">{savedTip}</div>}
          </section>
        </div>
      </div>
    </div>
  );
}
