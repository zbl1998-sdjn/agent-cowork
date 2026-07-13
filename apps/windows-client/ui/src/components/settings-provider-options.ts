// 设置模型提供商选项(UI · components)
// ---------------------------------------------------------------------------
// 职责:提供设置面板的离线回退目录与纯展示判定,不持有状态、不触发网络请求。
import type { ModelConnectionResult, ModelProviderOption } from '../lib/api';

export const FALLBACK_MODEL_PROVIDERS: ModelProviderOption[] = [
  { id: 'ollama', displayName: 'Ollama', region: 'local', protocol: 'openai-chat', defaultModel: 'qwen3', models: ['qwen3', 'qwen3-coder', 'qwen2.5:7b', 'qwen2.5:3b', 'qwen2.5:1.5b', 'qwen2.5:0.5b', 'deepseek-r1:7b', 'ibm/granite3.3:2b', 'lfm2.5-thinking:1.2b', 'qwen2.5vl:7b', 'minicpm-v4.5:latest', 'bge-m3:latest'], defaultBaseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: [], requiresApiKey: false, allowCustomBaseUrl: true, allowCustomModel: true, source: 'builtin' },
  { id: 'openai/local', displayName: '本机 OpenAI-compatible', region: 'local', protocol: 'openai-chat', defaultModel: 'qwen3', models: ['qwen3', 'qwen3-coder', 'qwen2.5:7b', 'qwen2.5:3b', 'qwen2.5:1.5b', 'qwen2.5:0.5b', 'deepseek-r1:7b', 'local-model'], defaultBaseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: [], requiresApiKey: false, allowCustomBaseUrl: true, allowCustomModel: true, source: 'builtin' },
  { id: 'lmstudio', displayName: 'LM Studio', region: 'local', protocol: 'openai-chat', defaultModel: 'local-model', models: ['local-model', 'qwen3', 'qwen3-coder', 'gpt-oss-20b', 'deepseek-r1', 'llama-3.1-8b-instruct'], defaultBaseUrl: 'http://127.0.0.1:1234/v1', apiKeyEnv: [], requiresApiKey: false, allowCustomBaseUrl: true, allowCustomModel: true, source: 'builtin' },
  { id: 'kimi-api', displayName: 'Kimi(月之暗面)', region: 'cn', protocol: 'openai-chat', defaultModel: 'kimi-k2.7-code', models: ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'kimi-k2.5'], defaultBaseUrl: 'https://api.moonshot.ai/v1', apiKeyEnv: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'], requiresApiKey: true, source: 'builtin' },
];

export function isLocalProviderOption(item: ModelProviderOption | undefined): boolean {
  if (!item) return false;
  const id = item.id.trim().toLowerCase();
  return item.region === 'local'
    || ['ollama', 'lmstudio', 'lm-studio', 'openai/local', 'local-openai', 'local'].includes(id)
    || id.includes('/local');
}

export function providerDisplayName(item: ModelProviderOption): string {
  if (isLocalProviderOption(item)) return item.displayName;
  return item.region === 'custom' || item.region === 'enterprise'
    ? `${item.displayName}（需管理员 allowlist）`
    : `${item.displayName}（目录/当前受限）`;
}

export function modelConnectionLabel(connection: ModelConnectionResult | null | undefined): string {
  if (!connection) return '尚未测试连接';
  if (connection.status === 'connected') {
    return `连接正常 · 找到 ${connection.models.length} 个模型 · ${connection.latencyMs}ms`;
  }
  if (connection.status === 'model_missing') return connection.error || '服务已连接，但当前模型未安装';
  if (connection.status === 'blocked') return '当前安全策略不允许调用这个地址';
  return connection.error || '无法连接到模型服务';
}
