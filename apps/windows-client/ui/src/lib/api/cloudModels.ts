// 云端模型开关 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:读取/写入本工作区"启用哪些公网云 provider"。启用后数据会发送到对应厂商,
//       由用户在设置里显式知情选择;后端把这些 provider 并入放行名单。
// 对应路由:/api/cloud-models。
import { getJson, postJson } from './transport';

export type CloudProviderOption = { id: string; displayName: string; host: string };
export type CloudModelsState = { enabled: boolean; providers: string[]; available: CloudProviderOption[] };

function normalize(raw: { enabled?: unknown; providers?: unknown; available?: unknown }): CloudModelsState {
  return {
    enabled: raw.enabled === true,
    providers: Array.isArray(raw.providers) ? raw.providers.map((p) => String(p)).filter(Boolean) : [],
    available: Array.isArray(raw.available)
      ? raw.available.map((item) => {
        const r = item && typeof item === 'object' ? item as Record<string, unknown> : {};
        return { id: String(r.id || ''), displayName: String(r.displayName || r.id || ''), host: String(r.host || '') };
      }).filter((p) => p.id)
      : [],
  };
}

export async function getCloudModels(): Promise<CloudModelsState> {
  return normalize(await getJson<Record<string, unknown>>('/api/cloud-models'));
}

export async function setCloudModels(enabled: boolean, providers: string[]): Promise<CloudModelsState> {
  return normalize(await postJson<Record<string, unknown>>('/api/cloud-models', { enabled, providers }));
}
