import { useEffect, useState } from 'react';
import { getKimiInfo, saveKimiConfig, type KimiInfo } from '../lib/api';
import { Button, IconButton } from './ui/Button';

interface ApiSettingsProps {
  onClose: () => void;
  onSaved: (info: KimiInfo) => void;
}

export function ApiSettingsActions({
  hasKey,
  busy,
  savedTip,
  onClearKey,
  onCancel,
  onSave,
}: {
  hasKey: boolean;
  busy: boolean;
  savedTip: string;
  onClearKey: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="modal-actions">
      {hasKey && <Button variant="danger" className="btn-ghost-danger" disabled={busy} onClick={onClearKey}>清除密钥</Button>}
      <span className="modal-actions-spacer">{savedTip && <span className="saved-tip">{savedTip}</span>}</span>
      <Button className="btn-secondary" disabled={busy} onClick={onCancel}>取消</Button>
      <Button variant="primary" className="btn-primary" disabled={busy} onClick={onSave}>{busy ? '保存中…' : '保存'}</Button>
    </div>
  );
}

// API settings modal (kimi.exe style): pre-fills baseUrl/model from the host and
// shows whether a key is set without ever exposing it. Saving an empty key keeps
// the existing one; the host only ever returns a `hasKey` boolean.
export function ApiSettings({ onClose, onSaved }: ApiSettingsProps) {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedTip, setSavedTip] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const info = await getKimiInfo();
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

  const save = async (clearKey = false) => {
    if (busy) return;
    setBusy(true); setError(''); setSavedTip('');
    try {
      const payload = clearKey
        ? { clearKey: true }
        : { apiKey: apiKey.trim() || undefined, baseUrl: baseUrl.trim() || undefined, model: model.trim() || undefined };
      const info = await saveKimiConfig(payload);
      setHasKey(Boolean(info.hasKey));
      setApiKey('');
      onSaved(info);
      setSavedTip(clearKey ? '密钥已清除' : '已保存');
      setTimeout(() => setSavedTip(''), 2500);
    } catch (err) {
      setError((err as Error).message || '保存失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="API 设置">
        <header className="modal-head">
          <h2>API 设置</h2>
          <IconButton className="modal-close" label="关闭" onClick={onClose}>×</IconButton>
        </header>
        {loading ? (
          <div className="modal-loading">加载中…</div>
        ) : (
          <div className="modal-body">
            <div className="api-help">
              <p><strong>如果你已有 Kimi(Moonshot)账号</strong>:把 API Key 填进下面那栏即可。</p>
              <p><strong>如果还没账号</strong>:去 <a href="https://platform.moonshot.cn/console/api-keys" target="_blank" rel="noreferrer">platform.moonshot.cn</a> 注册,生成一个 sk-… 的 API Key 复制过来。</p>
            </div>
            <label className="auth-field">
              <span>API Key {hasKey && <em className="key-set">已配置</em>}</span>
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={hasKey ? '已配置(留空保持不变)' : '从 Kimi 控制台复制的 sk-...'} autoComplete="off" />
            </label>
            <details className="api-advanced">
              <summary>高级设置(一般不用改)</summary>
              <label className="auth-field">
                <span>Base URL</span>
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.moonshot.cn/v1" />
              </label>
              <label className="auth-field">
                <span>模型</span>
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="kimi-k2-0905-preview" />
              </label>
            </details>
            {error && <div className="auth-error" role="alert">{error}</div>}
            <ApiSettingsActions hasKey={hasKey} busy={busy} savedTip={savedTip} onClearKey={() => void save(true)} onCancel={onClose} onSave={() => void save(false)} />
            <p className="modal-note">密钥仅保存在本机 .AgentCowork/config.json，绝不回传或显示明文。</p>
          </div>
        )}
      </div>
    </div>
  );
}
