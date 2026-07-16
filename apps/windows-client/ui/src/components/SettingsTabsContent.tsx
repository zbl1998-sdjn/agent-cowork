// SettingsTabsContent(UI · components):设置各标签内容——按当前标签 lazy 渲染 API/外观/连接器/更新等设置区。纯展示+回调。
import { lazy, Suspense } from 'react';
import { Button } from './ui/Button';
import { SettingsApiPanel } from './SettingsApiPanel';
import { SegmentedControl } from './ui/SegmentedControl';
import { Loading } from './ui/StateViews';
import type { AppFontFamily, AppFontScale } from './settings-types';
import type { SettingsTabsContentProps } from './settings-tabs-types';
export type { SettingsPersistPayload } from './settings-tabs-types';
import {
  FALLBACK_MODEL_PROVIDERS,
  modelConnectionLabel, providerDisplayName,
} from './settings-provider-options';

// 懒加载较重的运行时/更新子面板,避免打开账户标签时把这些 bundle 一起拖进来。
const RuntimeDependenciesPanel = lazy(() => import('./panels/RuntimeDependenciesPanel').then((m) => ({ default: m.RuntimeDependenciesPanel })));
const SkillPacksPanel = lazy(() => import('./panels/SkillPacksPanel').then((m) => ({ default: m.SkillPacksPanel })));
const UpdatePanel = lazy(() => import('./panels/UpdatePanel').then((m) => ({ default: m.UpdatePanel })));

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

// 设置模态框的纯展示正文:每个标签一个分支,尾部共享错误/保存提示。
// 从 Settings.tsx 拆出后,父组件控制状态,这里专注标签内容迭代。
export function SettingsTabsContent(props: SettingsTabsContentProps) {
  const {
    tab,
    username, tenantId, onLogout,
    theme, onSetTheme, fontScale, onSetFontScale, fontFamily, onSetFontFamily, autoClarify, onSetAutoClarify, autoContextCompaction, onSetAutoContextCompaction,
    provider, setProvider, providers, model, setModel, baseUrl, setBaseUrl,
    apiKey, setApiKey, hasKey, setHasKey, providerStates, availableModels,
    connection, testingConnection, onTestConnection, onProviderSelected,
    loading, busy, persist,
    selfCheck, scError, scLoading, onRefreshSelfCheck,
    error, savedTip,
  } = props;
  const providerOptions = providers?.length ? providers : FALLBACK_MODEL_PROVIDERS;
  const selectedProvider = providerOptions.find((item) => item.id === provider) || providerOptions[0];
  const knownModels = [...new Set([
    ...availableModels,
    selectedProvider?.defaultModel,
    ...(selectedProvider?.models || []),
  ].filter(Boolean))] as string[];
  const isCustomModel = Boolean(model) && !knownModels.includes(model);
  const selectProvider = (next: string) => {
    const nextProvider = providerOptions.find((item) => item.id === next);
    if (onProviderSelected) {
      onProviderSelected(next);
      return;
    }
    const nextState = providerStates.find((item) => item.provider === next);
    setProvider(next);
    setApiKey('');
    setHasKey(Boolean(nextState?.hasKey));
    setModel(nextState?.model || nextProvider?.defaultModel || '');
    setBaseUrl(nextState?.baseUrl || nextProvider?.defaultBaseUrl || '');
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
              {providerOptions.map((item) => <option key={item.id} value={item.id}>{providerDisplayName(item)}</option>)}
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
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={selectedProvider?.defaultModel || '如 local-model'} autoFocus />
            </label>
          )}
          <p className="modal-note">模型按 provider_id/model_id 管理；换厂商会自动带出它的推荐模型。这里存默认值，每轮对话仍可临时切换。</p>
          <p className="modal-note">当前 Internal Beta 仅执行本地模型或管理员明确放行的客户网关；公网 provider 只提供目录/配置发现。</p>
          <p className="modal-note" role="status">连接状态：{modelConnectionLabel(connection)}</p>
          <div className="modal-actions">
            <Button className="btn-secondary" disabled={busy || testingConnection} onClick={onTestConnection}>{testingConnection ? '检测中…' : '测试连接'}</Button>
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
          <p className="modal-note">开启后,模糊请求(如「整理一下」)发出去之前,模型会先反问一两个具体问题,确认要做什么,再开始干活。多花 3 秒,少返工一轮。</p>
          <div className="set-row">
            <span className="set-label">自动压缩上下文</span>
            <SegmentedControl ariaLabel="自动压缩上下文" className="seg" value={autoContextCompaction} options={AUTO_CLARIFY_OPTIONS} onChange={onSetAutoContextCompaction} />
          </div>
          <p className="modal-note">开启后,长对话会自动把较早消息折叠为摘要,减少超上下文失败和无效 token 消耗。</p>
        </div>
      )}
      {tab === 'api' && (
        loading ? <div className="modal-loading">加载中…</div> : (
          <SettingsApiPanel
            provider={provider}
            providerOptions={providerOptions}
            apiKey={apiKey}
            setApiKey={setApiKey}
            hasKey={hasKey}
            baseUrl={baseUrl}
            setBaseUrl={setBaseUrl}
            connection={connection}
            busy={busy}
            testingConnection={testingConnection}
            onTestConnection={onTestConnection}
            selectProvider={selectProvider}
            persist={persist}
          />
        )
      )}
      {tab === 'skills' && (
        <Suspense fallback={<Loading message="正在加载技能包…" />}>
          <SkillPacksPanel />
        </Suspense>
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
