// OllamaCloudSection(UI · components/panels):云端模型区里的 Ollama Cloud 一键接入。
// 办公电脑无 GPU 也能用:登录 Ollama 云(浏览器设备配对)后,拉一个 -cloud 模型,
// 算力在 Ollama 云端,本机仅经 127.0.0.1:11434 调用(不动本地安全边界)。
import { useEffect, useState } from 'react';
import { ollamaCloudPull, ollamaCloudRecommended, ollamaCloudSignin } from '../../lib/api';
import { humanizeError } from '../../lib/friendly-error';
import { Button } from '../ui/Button';

export function OllamaCloudSection() {
  const [recommended, setRecommended] = useState<string[]>([]);
  const [connectUrl, setConnectUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { ollamaCloudRecommended().then(setRecommended).catch(() => setRecommended([])); }, []);

  const signin = () => {
    setBusy('signin'); setError(''); setNote('');
    ollamaCloudSignin()
      .then((r) => {
        setConnectUrl(r.connectUrl);
        setNote(r.connectUrl ? '浏览器已尝试打开,请在页面上确认登录;若没打开,点下方链接。' : '已触发登录,请按 Ollama 提示在浏览器完成。');
      })
      .catch((err) => setError(humanizeError(err, { action: '登录 Ollama 云(需已安装 Ollama)' })))
      .finally(() => setBusy(''));
  };

  const pull = (model: string) => {
    setBusy(model); setError(''); setNote('');
    ollamaCloudPull(model)
      .then(() => setNote(`已拉取 ${model}。到「默认模型」页选 Ollama,即可在模型列表里选它。`))
      .catch((err) => setError(humanizeError(err, { action: `拉取 ${model}(需先登录 Ollama 云)` })))
      .finally(() => setBusy(''));
  };

  return (
    <div className="ollama-cloud skill-pack-item" style={{ display: 'block' }}>
      <div className="skill-pack-meta" style={{ marginBottom: 8 }}>
        <code>Ollama 云(免配置 · 云端算力)</code>
        <span>办公电脑没有 GPU 也能用大模型:登录后模型在 Ollama 云端运行,本机不吃配置。需已安装 Ollama。</span>
      </div>
      {error && <div className="panel-error" role="alert">{error}</div>}
      {note && <p className="settings-hint" role="status">{note}</p>}
      <div className="modal-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
        <Button variant="primary" disabled={Boolean(busy)} onClick={signin}>{busy === 'signin' ? '登录中…' : '登录 Ollama 云'}</Button>
        {connectUrl && <a href={connectUrl} target="_blank" rel="noreferrer" className="settings-hint">打开配对链接 →</a>}
      </div>
      {recommended.length > 0 && (
        <>
          <p className="settings-hint" style={{ marginTop: 10 }}>登录后拉一个云端模型:</p>
          <div className="modal-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
            {recommended.map((m) => (
              <Button key={m} variant="secondary" disabled={Boolean(busy)} onClick={() => pull(m)}>
                {busy === m ? `拉取中…` : m}
              </Button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
