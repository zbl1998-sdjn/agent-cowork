// Kimi 配置 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:读取/保存模型(provider/key/baseUrl/model)配置及其启用与连通状态。
// 依赖/对应路由:GET /api/kimi/info、POST /api/kimi/config。导出:getKimiInfo / saveKimiConfig + KimiInfo / SaveKimiConfigInput 类型。
import { getJson, postJson } from './transport';

export interface KimiInfo {
  provider?: string | undefined;
  configured: boolean;
  chatEnabled: boolean;
  planEnabled: boolean;
  model: string;
  baseUrl?: string | undefined;
  hasKey?: boolean | undefined;
}

export async function getKimiInfo(): Promise<KimiInfo> {
  return getJson('/api/kimi/info');
}

export interface SaveKimiConfigInput {
  provider?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  clearKey?: boolean | undefined;
}

export async function saveKimiConfig(input: SaveKimiConfigInput): Promise<KimiInfo> {
  return postJson<KimiInfo>('/api/kimi/config', { ...input });
}
