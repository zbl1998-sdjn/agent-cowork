import type { ModelConnectionResult, ModelProviderOption } from '../lib/api';
import { Button } from './ui/Button';
import { isLocalProviderOption, modelConnectionLabel, providerDisplayName } from './settings-provider-options';

type ApiPersistPayload = {
  provider?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  clearKey?: boolean | undefined;
};

interface SettingsApiPanelProps {
  provider: string;
  providerOptions: ModelProviderOption[];
  apiKey: string;
  setApiKey: (value: string) => void;
  hasKey: boolean;
  baseUrl: string;
  setBaseUrl: (value: string) => void;
  connection: ModelConnectionResult | null;
  busy: boolean;
  testingConnection: boolean;
  onTestConnection: () => void;
  selectProvider: (provider: string) => void;
  persist: (payload: ApiPersistPayload, okMsg: string) => void;
}

export function SettingsApiPanel(props: SettingsApiPanelProps) {
  const {
    provider, providerOptions, apiKey, setApiKey, hasKey, baseUrl, setBaseUrl,
    connection, busy, testingConnection, onTestConnection, selectProvider, persist,
  } = props;
  const selectedProvider = providerOptions.find((item) => item.id === provider) || providerOptions[0];
  const providerLabel = selectedProvider?.displayName || provider || '模型提供商';
  const apiKeyNames = selectedProvider?.apiKeyEnv?.length
    ? selectedProvider.apiKeyEnv.join(' / ')
    : '本地模型通常不需要 API Key';
  const placeholder = hasKey
    ? '已配置(留空保持不变)'
    : isLocalProviderOption(selectedProvider)
      ? '本地模型可留空'
      : selectedProvider?.region === 'custom' || selectedProvider?.region === 'enterprise'
        ? '保存网关凭据（启用需管理员 allowlist）'
        : '仅保存配置（当前不启用公网出站）';

  return (
    <div>
      <label className="auth-field">
        <span>提供商</span>
        <select value={provider} onChange={(event) => selectProvider(event.target.value)}>
          {providerOptions.map((item) => <option key={item.id} value={item.id}>{providerDisplayName(item)}</option>)}
        </select>
      </label>
      <p className="modal-note">当前配置:{providerLabel}。环境变量:{apiKeyNames}。</p>
      <p className="modal-note">当前 Internal Beta 仅执行本地模型或管理员明确放行的客户网关；公网 provider 只提供目录/配置发现。</p>
      <label className="auth-field">
        <span>API Key {hasKey && <em className="key-set">已配置</em>}</span>
        <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={placeholder} autoComplete="off" />
      </label>
      <details className="api-advanced">
        <summary>高级:接口地址(一般不用改)</summary>
        <label className="auth-field">
          <span>Base URL</span>
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={selectedProvider?.defaultBaseUrl || 'https://.../v1'} />
        </label>
        <p className="modal-note">内置 provider 会带默认地址；自建 OpenAI-compatible 或本地服务时再修改。</p>
      </details>
      <p className="modal-note" role="status">连接状态：{modelConnectionLabel(connection)}</p>
      <div className="modal-actions">
        {hasKey && <Button variant="danger" className="btn-ghost-danger" disabled={busy} onClick={() => persist({ clearKey: true }, '密钥已清除')}>清除密钥</Button>}
        <Button className="btn-secondary" disabled={busy || testingConnection} onClick={onTestConnection}>{testingConnection ? '检测中…' : '测试连接'}</Button>
        <span className="modal-actions-spacer" />
        <Button variant="primary" className="btn-primary" disabled={busy} onClick={() => persist({ provider, apiKey: apiKey.trim() || undefined, baseUrl: baseUrl.trim() || undefined }, '已保存')}>保存</Button>
      </div>
      <p className="modal-note">密钥仅保存在你本机的 .AgentCowork/config.json,绝不会回传或显示出明文。</p>
    </div>
  );
}
