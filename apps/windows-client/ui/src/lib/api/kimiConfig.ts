// Kimi 配置 API(UI · lib/api 传输层):封装 /api/kimi/* —— 读取/保存模型配置与连通性诊断。
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
