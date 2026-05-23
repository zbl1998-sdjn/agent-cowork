import { useState, type FormEvent } from 'react';
import { login as apiLogin, register as apiRegister, type AuthIdentity } from '../lib/api';

interface LoginProps {
  onAuthed: (identity: AuthIdentity) => void;
  onGuest: () => void;
}

// Full-screen sign-in gate, styled after the Kimi desktop app: a branded left
// panel and a clean centered auth card on the right. Login + register share one
// form; a guest link lets local single-user setups skip straight in.
export function Login({ onAuthed, onGuest }: LoginProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    const u = username.trim();
    if (!u) { setError('请输入用户名'); return; }
    if (password.length < 6) { setError('密码至少 6 位'); return; }
    setBusy(true);
    try {
      const identity = mode === 'login' ? await apiLogin(u, password) : await apiRegister(u, password);
      onAuthed(identity);
    } catch (err) {
      setError((err as Error).message || '操作失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <aside className="auth-aside" aria-hidden="true">
        <div className="auth-aside-inner">
          <span className="auth-logo"><span className="brand-dot auth-brand-dot" />Kimi Cowork</span>
          <h2>你的本地办公智能体</h2>
          <p>读写工作区文件、运行代码、连接你的工具——全部在本机完成，关键操作先经你批准。</p>
        </div>
      </aside>
      <main className="auth-main">
        <form className="auth-card" onSubmit={submit}>
          <h1 className="auth-title">{mode === 'login' ? '登录' : '创建账户'}</h1>
          <p className="auth-sub">{mode === 'login' ? '欢迎回来，登录后继续工作。' : '注册一个本地账户开始使用。'}</p>
          <div className="auth-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'is-active' : ''} onClick={() => { setMode('login'); setError(''); }}>登录</button>
            <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'is-active' : ''} onClick={() => { setMode('register'); setError(''); }}>注册</button>
          </div>
          <label className="auth-field">
            <span>用户名</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" placeholder="3-40 位，字母/数字/_.-" />
          </label>
          <label className="auth-field">
            <span>密码</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder="至少 6 位" />
          </label>
          {error && <div className="auth-error" role="alert">{error}</div>}
          <button type="submit" className="auth-submit" disabled={busy}>{busy ? '请稍候…' : (mode === 'login' ? '登录' : '注册并登录')}</button>
          <button type="button" className="auth-guest" onClick={onGuest}>跳过，先在本地使用 →</button>
        </form>
        <p className="auth-foot">账户信息仅保存在本机，用于区分多用户的工作数据。</p>
      </main>
    </div>
  );
}
