import { useEffect, useState } from 'react';
import { getKimiInfo, saveKimiConfig, type KimiInfo } from '../lib/api';

interface ApiSettingsProps {
  onClose: () => void;
  onSaved: (info: KimiInfo) => void;
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
          <button type="button" className="modal-close" aria-label="关闭" onClick={onClose}>×</button>
        </header>
        {loading ? (
          <div className="modal-loading">加载中…</div>
        ) : (
          <div className="modal-body">
            <label className="auth-field">
              <span>API Key {hasKey && <em className="key-set">已配置</em>}</span>
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={hasKey ? '已配置（留空保持不变）' : 'sk-...'} autoComplete="off" />
            </label>
            <label className="auth-field">
              <span>Base URL</span>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.moonshot.cn/v1" />
            </label>
            <label className="auth-field">
              <span>模型</span>
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="kimi-k2-0905-preview" />
            </label>
            {error && <div className="auth-error" role="alert">{error}</div>}
            <div className="modal-actions">
              {hasKey && <button type="button" className="btn-ghost-danger" disabled={busy} onClick={() => void save(true)}>清除密钥</button>}
              <span className="modal-actions-spacer">{savedTip && <span className="saved-tip">{savedTip}</span>}</span>
              <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>取消</button>
              <button type="button" className="btn-primary" disabled={busy} onClick={() => void save(false)}>{busy ? '保存中…' : '保存'}</button>
            </div>
            <p className="modal-note">密钥仅保存在本机 .KimiCowork/config.json，绝不回传或显示明文。</p>
          </div>
        )}
      </div>
    </div>
  );
}
