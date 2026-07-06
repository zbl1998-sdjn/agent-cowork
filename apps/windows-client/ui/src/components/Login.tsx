// Login 登录门面(UI · 组件层 · components)
// ---------------------------------------------------------------------------
// 职责:全屏登录/注册卡片,校验用户名与密码后调 lib/api 的 login/register,成功经 onAuthed 回传身份;另提供访客入口 onGuest。
// 依赖:lib/api(login/register/AuthIdentity)+ ui/Button。关键回调:onAuthed、onGuest。
import { useState, type CSSProperties, type FormEvent } from 'react';
import { login as apiLogin, register as apiRegister, type AuthIdentity } from '../lib/api';
import { Button } from './ui/Button';

interface LoginProps {
  onAuthed: (identity: AuthIdentity) => void;
  onGuest: () => void;
}

function authTabStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    border: 'none',
    background: active ? 'var(--surface)' : 'transparent',
    color: active ? 'var(--text)' : 'var(--muted)',
    boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
    fontWeight: active ? 500 : undefined,
    padding: '8px 0',
    borderRadius: 8,
  };
}

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
    <div className="auth-screen auth-screen-quiet">
      <main className="auth-main">
        <form className="auth-card" onSubmit={submit}>
          <div className="auth-card-brand">
            <span className="brand-dot auth-brand-dot" aria-hidden="true" />
            <span>Agent Cowork</span>
            <span className="auth-release-badge" title="Internal beta build">Beta</span>
          </div>
          <h1 className="auth-title">{mode === 'login' ? '登录' : '创建账户'}</h1>
          <p className="auth-sub">{mode === 'login' ? '继续你的本地工作。' : '创建本地账户，隔离你的工作数据。'}</p>
          <div className="auth-tabs" role="tablist">
            <Button role="tab" aria-selected={mode === 'login'} variant="ghost" className={mode === 'login' ? 'is-active' : ''} onClick={() => { setMode('login'); setError(''); }} style={authTabStyle(mode === 'login')}>登录</Button>
            <Button role="tab" aria-selected={mode === 'register'} variant="ghost" className={mode === 'register' ? 'is-active' : ''} onClick={() => { setMode('register'); setError(''); }} style={authTabStyle(mode === 'register')}>注册</Button>
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
          <Button type="submit" variant="primary" className="auth-submit" disabled={busy} style={{ border: 'none', borderRadius: 10, padding: 12, fontSize: 14, fontWeight: 600, cursor: busy ? 'progress' : 'pointer' }}>{busy ? '请稍候…' : (mode === 'login' ? '登录' : '注册并登录')}</Button>
          <Button variant="ghost" className="auth-guest" onClick={onGuest} style={{ border: 'none', background: 'none', color: 'var(--muted)', marginTop: 12, padding: 6, fontSize: 13 }}>跳过，先在本地使用 →</Button>
        </form>
        <p className="auth-foot">账户信息仅保存在本机，用于区分多用户的工作数据。</p>
      </main>
    </div>
  );
}
