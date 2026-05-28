import { lazy, Suspense } from 'react';
import type { SelfCheckResult } from '../lib/api';
import { Button } from './ui/Button';
import { SegmentedControl } from './ui/SegmentedControl';
import { Loading } from './ui/StateViews';
import type { SettingsTab } from './settings-types';

// Lazy-load the heavy runtime / updates sub-panels so opening Settings on the
// account tab doesn't drag their bundles in. Mirrors the original Settings.tsx.
const RuntimeDependenciesPanel = lazy(() => import('./panels/RuntimeDependenciesPanel').then((m) => ({ default: m.RuntimeDependenciesPanel })));
const UpdatePanel = lazy(() => import('./panels/UpdatePanel').then((m) => ({ default: m.UpdatePanel })));

const MODEL_PROVIDERS = [
  { value: 'kimi-api', label: 'Kimi(月之暗面)' },
  { value: 'openai', label: 'OpenAI(ChatGPT)' },
  { value: 'anthropic', label: 'Claude' },
  { value: 'openai/local', label: '本机 / 自建(高级)' },
];

// Commonly used Kimi models. Free-form input still allowed so the user can
// paste any model id their provider exposes — the datalist is just a quick
// pick to spare non-technical users from typing "kimi-k2-0905-preview".
const COMMON_KIMI_MODELS = [
  'kimi-k2-0905-preview',
  'kimi-latest',
  'moonshot-v1-8k',
  'moonshot-v1-32k',
  'moonshot-v1-128k',
];

const THEME_OPTIONS: Array<{ value: 'light' | 'dark'; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

const AUTO_CLARIFY_OPTIONS: Array<{ value: boolean; label: string }> = [
  { value: false, label: '关闭' },
  { value: true, label: '开启' },
];

export interface SettingsPersistPayload {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  clearKey?: boolean;
}

export interface SettingsTabsContentProps {
  tab: SettingsTab;
  // identity
  username: string;
  tenantId: string;
  onLogout: () => void;
  // appearance / input
  theme: 'light' | 'dark';
  onSetTheme: (t: 'light' | 'dark') => void;
  autoClarify: boolean;
  onSetAutoClarify: (enabled: boolean) => void;
  // model / api state
  provider: string;
  setProvider: (v: string) => void;
  model: string;
  setModel: (v: string) => void;
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  apiKey: string;
  setApiKey: (v: string) => void;
  hasKey: boolean;
  loading: boolean;
  busy: boolean;
  persist: (payload: SettingsPersistPayload, okMsg: string) => void;
  // selfcheck
  selfCheck: SelfCheckResult | null;
  scError: string;
  scLoading: boolean;
  onRefreshSelfCheck: () => void;
  // shared output line
  error: string;
  savedTip: string;
}

// Pure presentational body of the settings modal — one branch per tab,
// followed by the shared error/saved-tip strip. Extracted from Settings.tsx
// so the parent stays under the file-size soft limit and so each tab body
// is easy to find / iterate on without scrolling past the state plumbing.
export function SettingsTabsContent(props: SettingsTabsContentProps) {
  const {
    tab,
    username, tenantId, onLogout,
    theme, onSetTheme, autoClarify, onSetAutoClarify,
    provider, setProvider, model, setModel, baseUrl, setBaseUrl,
    apiKey, setApiKey, hasKey, loading, busy, persist,
    selfCheck, scError, scLoading, onRefreshSelfCheck,
    error, savedTip,
  } = props;

  return (
    <section className="settings-pane">
      {tab === 'account' && (
        <div>
          <div className="set-row"><span className="set-label">用户名</span><span className="set-val">{username}</span></div>
          <div className="set-row"><span className="set-label">租户</span><span className="set-val">{tenantId}</span></div>
          <Button className="btn-secondary" onClick={onLogout}>退出登录</Button>
        </div>
      )}
      {tab === 'appearance' && (
        <div className="set-row">
          <span className="set-label">主题</span>
          <SegmentedControl ariaLabel="主题" className="seg" value={theme} options={THEME_OPTIONS} onChange={onSetTheme} />
        </div>
      )}
      {tab === 'model' && (
        <div>
          <label className="auth-field">
            <span>默认用哪家</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              {MODEL_PROVIDERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label className="auth-field">
            <span>默认模型名称</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="点开选一个,或直接粘贴" list="settings-common-models" />
            <datalist id="settings-common-models">
              {COMMON_KIMI_MODELS.map((m) => <option key={m} value={m} />)}
            </datalist>
          </label>
          <p className="modal-note">不知道选哪个就保持默认。后面在每轮对话里也可以临时换。</p>
          <div className="modal-actions">
            <span className="modal-actions-spacer" />
            <Button variant="primary" className="btn-primary" disabled={busy} onClick={() => persist({ provider, model: model.trim() || undefined }, '模型已保存')}>保存</Button>
          </div>
        </div>
      )}
      {tab === 'input' && (
        <div>
          <div className="set-row">
            <span className="set-label">发送前澄清</span>
            <SegmentedControl ariaLabel="发送前澄清" className="seg" value={autoClarify} options={AUTO_CLARIFY_OPTIONS} onChange={onSetAutoClarify} />
          </div>
          <p className="modal-note">开启后,模糊请求(如「整理一下」)发出去之前,Kimi 会先反问一两个具体问题,确认要做什么,再开始干活。多花 3 秒,少返工一轮。</p>
        </div>
      )}
      {tab === 'api' && (
        loading ? <div className="modal-loading">加载中…</div> : (
          <div>
            <p className="modal-note">还没有 Kimi 账号?去 <a href="https://platform.moonshot.cn" target="_blank" rel="noreferrer">platform.moonshot.cn</a> 注册,在「API Key 管理」里新建一个 sk- 开头的密钥贴进来即可。</p>
            <label className="auth-field">
              <span>API Key {hasKey && <em className="key-set">已配置</em>}</span>
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={hasKey ? '已配置(留空保持不变)' : 'sk-...'} autoComplete="off" />
            </label>
            <details className="api-advanced">
              <summary>高级:接口地址(一般不用改)</summary>
              <label className="auth-field">
                <span>Base URL</span>
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.moonshot.cn/v1" />
              </label>
              <p className="modal-note">国内访问 Kimi 用默认值即可。仅当用代理或自建 OpenAI 兼容接口时才需要修改。</p>
            </details>
            <div className="modal-actions">
              {hasKey && <Button variant="danger" className="btn-ghost-danger" disabled={busy} onClick={() => persist({ clearKey: true }, '密钥已清除')}>清除密钥</Button>}
              <span className="modal-actions-spacer" />
              <Button variant="primary" className="btn-primary" disabled={busy} onClick={() => persist({ provider, apiKey: apiKey.trim() || undefined, baseUrl: baseUrl.trim() || undefined }, '已保存')}>保存</Button>
            </div>
            <p className="modal-note">密钥仅保存在你本机的 .AgentCowork/config.json,绝不会回传或显示出明文。</p>
          </div>
        )
      )}
      {tab === 'runtime' && (
        <Suspense fallback={<Loading message="正在加载运行时状态…" />}>
          <RuntimeDependenciesPanel />
        </Suspense>
      )}
      {tab === 'updates' && (
        <Suspense fallback={<Loading message="正在加载更新状态…" />}>
          <UpdatePanel />
        </Suspense>
      )}
      {tab === 'selfcheck' && (
        <div className="selfcheck">
          <div className="selfcheck-head">
            <span className="set-label">系统健康检查</span>
            <Button className="btn-secondary" disabled={scLoading} onClick={onRefreshSelfCheck}>{scLoading ? '检测中…' : '重新检查'}</Button>
          </div>
          <p className="modal-note">这里把后台跑得是否健康一次性列出来,出问题时方便排查。普通使用一般不用看。</p>
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
              <details className="selfcheck-detail">
                <summary>系统底层细节(技术信息)</summary>
                <p className="modal-note">
                  数据存哪儿:{selfCheck.storage.backend}{selfCheck.storage.postgres ? '(多实例)' : ''} ·
                  命令执行沙箱:{selfCheck.sandbox.backend || '未启用'}({selfCheck.sandbox.networkIsolated ? '已隔离网络' : '未隔离网络'}) ·
                  正在跑的任务数:{selfCheck.resilience.concurrency.active}/{selfCheck.resilience.concurrency.maxConcurrent} ·
                  限流:{selfCheck.resilience.rateLimit.enabled ? `${selfCheck.resilience.rateLimit.ratePerSec}/秒` : '未启用'}
                </p>
              </details>
            </>
          )}
        </div>
      )}
      {error && <div className="auth-error" role="alert">{error}</div>}
      {savedTip && <div className="saved-tip">{savedTip}</div>}
    </section>
  );
}
