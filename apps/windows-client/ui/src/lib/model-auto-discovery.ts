// model-auto-discovery(UI · lib 纯逻辑层)
// ---------------------------------------------------------------------------
// 职责:判定「默认模型」设置页是否应自动发现模型列表(等价自动点一次"测试连接")。
//       只对 region==='local' 的回环 provider(Ollama/LM Studio/本地 OpenAI 兼容)自动发起;
//       云端 provider 一律不自动外发请求,保持"不静默出网"的数据安全口径。纯函数。
export type ModelAutoDiscoveryInput = {
  tab: string;
  loading: boolean;
  testingConnection: boolean;
  providerRegion: string | undefined;
  hasModels: boolean;
  hasConnection: boolean;
};

export function shouldAutoDiscoverModels({ tab, loading, testingConnection, providerRegion, hasModels, hasConnection }: ModelAutoDiscoveryInput): boolean {
  if (tab !== 'model' || loading || testingConnection) return false;
  if (providerRegion !== 'local') return false;
  return !hasModels && !hasConnection;
}
