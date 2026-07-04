// SettingsTabsContent(UI · components):设置各标签内容——按当前标签 lazy 渲染 API/外观/连接器/更新等设置区。纯展示+回调。
import { lazy, Suspense } from 'react';
import type { ModelProviderOption, SelfCheckResult } from '../lib/api';
import { Button } from './ui/Button';
import { SegmentedControl } from './ui/SegmentedControl';
import { Loading } from './ui/StateViews';
import type { AppFontFamily, AppFontScale, SettingsTab } from './settings-types';

// 懒加载较重的运行时/更新子面板,避免打开账户标签时把这些 bundle 一起拖进来。
const RuntimeDependenciesPanel = lazy(() => import('./panels/RuntimeDependenciesPanel').then((m) => ({ default: m.RuntimeDependenciesPanel })));
const UpdatePanel = lazy(() => import('./panels/UpdatePanel').then((m) => ({ default: m.UpdatePanel })));

const FALLBACK_MODEL_PROVIDERS: ModelProviderOption[] = [
  { id: 'kimi-api', displayName: 'Kimi(月之暗面)', region: 'cn', protocol: 'openai-chat', defaultModel: 'kimi-k2.7-code', models: ['kimi-k2.7-code', 'kimi-k2.6'], defaultBaseUrl: 'https://api.moonshot.ai/v1', apiKeyEnv: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'], requiresApiKey: true, source: 'builtin' },
  { id: 'ollama', displayName: 'Ollama', region: 'local', protocol: 'openai-chat', defaultModel: 'qwen2.5:0.5b', models: ['qwen2.5:0.5b', 'qwen2.5:1.5b', 'qwen2.5:3b', 'qwen2.5:7b', 'deepseek-r1:7b', 'ibm/granite3.3:2b', 'lfm2.5-thinking:1.2b', 'qwen2.5vl:7b', 'minicpm-v4.5:latest', 'bge-m3:latest'], defaultBaseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: [], requiresApiKey: false, allowCustomBaseUrl: true, allowCustomModel: true, source: 'builtin' },
  { id: 'openai/local', displayName: '本机 OpenAI-compatible', region: 'local', protocol: 'openai-chat', defaultModel: 'qwen2.5:0.5b', models: ['qwen2.5:0.5b', 'qwen2.5:1.5b', 'qwen2.5:3b', 'qwen2.5:7b', 'deepseek-r1:7b', 'local-model'], defaultBaseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: [], requiresApiKey: false, allowCustomBaseUrl: true, allowCustomModel: true, source: 'builtin' },
  { id: 'lmstudio', displayName: 'LM Studio', region: 'local', protocol: 'openai-chat', defaultModel: 'local-model', models: ['local-model', 'qwen3', 'deepseek-r1', 'llama-3.1-8b-instruct'], defaultBaseUrl: 'http://127.0.0.1:1234/v1', apiKeyEnv: [], requiresApiKey: false, allowCustomBaseUrl: true, allowCustomModel: true, source: 'builtin' },
];

const THEME_OPTIONS: Array<{ value: 'light' | 'dark'; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

const FONT_SCALE_OPTIONS: Array<{ value: AppFontScale; label: string }> = [
  { value: 'small', label: '小' },
  { value: 'normal', label: '默认' },
  { value: 'large', label: '大' },
  { value: 'xlarge', label: '特大' },
];

const FONT_FAMILY_OPTIONS: Array<{ value: AppFontFamily; label: string }> = [
  { value: 'system', label: '系统' },
  { value: 'chinese', label: '中文' },
  { value: 'serif', label: '宋体' },
  { value: 'mono', label: '等宽' },
];

const AUTO_CLARIFY_OPTIONS: Array<{ value: boolean; label: string }> = [
  { value: false, label: '关闭' },
  { value: true, label: '开启' },
];

export interface SettingsPersistPayload {
  provider?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  clearKey?: boolean | undefined;
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
  fontScale: AppFontScale;
  onSetFontScale: (scale: AppFontScale) => void;
  fontFamily: AppFontFamily;
  onSetFontFamily: (family: AppFontFamily) => void;
  autoClarify: boolean;
  onSetAutoClarify: (enabled: boolean) => void;
  // model / api state
  provider: string;
  setProvider: (v: string) => void;
  providers?: ModelProviderOption[] | undefined;
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

// 设置模态框的纯展示正文:每个标签一个分支,尾部共享错误/保存提示。
// 从 Settings.tsx 拆出后,父组件控制状态,这里专注标签内容迭代。
export function SettingsTabsContent(props: SettingsTabsContentProps) {
  const {
    tab,
    username, tenantId, onLogout,
    theme, onSetTheme, fontScale, onSetFontScale, fontFamily, onSetFontFamily, autoClarify, onSetAutoClarify,
    provider, setProvider, providers, model, setModel, baseUrl, setBaseUrl,
    apiKey, setApiKey, hasKey, loading, busy, persist,
    selfCheck, scError, scLoading, onRefreshSelfCheck,
    error, savedTip,
  } = props;
  const providerOptions = providers?.length ? providers : FALLBACK_MODEL_PROVIDERS;
  const selectedProvider = providerOptions.find((item) => item.id === provider) || providerOptions[0];
  const knownModels = [...new Set([selectedProvider?.defaultModel, ...(selectedProvider?.models || [])].filter(Boolean))] as string[];
  const isCustomModel = Boolean(model) && !knownModels.includes(model);
  const providerLabel = selectedProvider?.displayName || provider || '模型提供商';
  const apiKeyNames = selectedProvider?.apiKeyEnv?.length ? selectedProvider.apiKeyEnv.join(' / ') : '本地模型通常不需要 API Key';
  const selectProvider = (next: string) => {
    const nextProvider = providerOptions.find((item) => item.id === next);
    setProvider(next);
    if (nextProvider?.defaultModel) setModel(nextProvider.defaultModel);
    if (nextProvider?.defaultBaseUrl) setBaseUrl(nextProvider.defaultBaseUrl);
  };

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
        <div className="settings-stack">
          <div className="set-row">
            <span className="set-label">主题</span>
            <SegmentedControl ariaLabel="主题" className="seg" value={theme} options={THEME_OPTIONS} onChange={onSetTheme} />
          </div>
          <div className="set-row">
            <span className="set-label">字体大小</span>
            <SegmentedControl ariaLabel="字体大小" className="seg" value={fontScale} options={FONT_SCALE_OPTIONS} onChange={onSetFontScale} />
          </div>
          <div className="set-row">
            <span className="set-label">字体</span>
            <SegmentedControl ariaLabel="字体" className="seg" value={fontFamily} options={FONT_FAMILY_OPTIONS} onChange={onSetFontFamily} />
          </div>
          <p className="modal-note">字体设置会立即应用到对话、工作台、按钮和设置面板；等宽字体适合看代码和日志。</p>
        </div>
      )}
      {tab === 'model' && (
        <div>
          <label className="auth-field">
            <span>默认用哪家</span>
            <select value={provider} onChange={(e) => selectProvider(e.target.value)}>
              {providerOptions.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
            </select>
          </label>
          <label className="auth-field">
            <span>默认模型{knownModels.length ? `（${knownModels.length} 个可选）` : ''}</span>
            <select
              value={isCustomModel ? '__custom__' : model}
              onChange={(e) => { const v = e.target.value; setModel(v === '__custom__' ? '' : v); }}
            >
              {!model && <option value="" disabled>选一个模型…</option>}
              {knownModels.map((m) => <option key={m} value={m}>{m}</option>)}
              <option value="__custom__">自定义（手动填 model id）…</option>
            </select>
          </label>
          {isCustomModel && (
            <label className="auth-field">
              <span>自定义 model id</span>
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={selectedProvider?.defaultModel || '如 kimi-k2-0905-preview'} autoFocus />
            </label>
          )}
          <p className="modal-note">模型按 provider_id/model_id 管理；换厂商会自动带出它的推荐模型。这里存默认值，每轮对话仍可临时切换。</p>
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
            <label className="auth-field">
              <span>提供商</span>
              <select value={provider} onChange={(e) => selectProvider(e.target.value)}>
                {providerOptions.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
              </select>
            </label>
            <p className="modal-note">当前配置:{providerLabel}。环境变量:{apiKeyNames}。</p>
            <label className="auth-field">
              <span>API Key {hasKey && <em className="key-set">已配置</em>}</span>
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={hasKey ? '已配置(留空保持不变)' : (selectedProvider?.requiresApiKey ? '粘贴 API Key' : '本地模型可留空')} autoComplete="off" />
            </label>
            <details className="api-advanced">
              <summary>高级:接口地址(一般不用改)</summary>
              <label className="auth-field">
                <span>Base URL</span>
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={selectedProvider?.defaultBaseUrl || 'https://.../v1'} />
              </label>
              <p className="modal-note">内置 provider 会带默认地址；自建 OpenAI-compatible 或本地服务时再修改。</p>
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
