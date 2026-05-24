import { getJson, postJson } from './transport';

export interface KimiInfo {
  configured: boolean;
  chatEnabled: boolean;
  planEnabled: boolean;
  model: string;
  baseUrl?: string;
  hasKey?: boolean;
}

export async function getKimiInfo(): Promise<KimiInfo> {
  return getJson('/api/kimi/info');
}

export interface SaveKimiConfigInput {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  clearKey?: boolean;
}

export async function saveKimiConfig(input: SaveKimiConfigInput): Promise<KimiInfo> {
  return postJson<KimiInfo>('/api/kimi/config', { ...input });
}
