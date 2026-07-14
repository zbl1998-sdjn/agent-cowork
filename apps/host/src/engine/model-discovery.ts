// Provider model discovery (host L1 engine domain).
// Probes the standard /models endpoint through the shared secure model network boundary.
import { createModelEndpointFetch } from '../security/model-endpoint-request.js';

export type ModelConnectionStatus = 'connected' | 'model_missing' | 'unreachable' | 'blocked';
export type ModelDiscoveryResult = {
  status: ModelConnectionStatus;
  models: string[];
  modelAvailable?: boolean;
  latencyMs: number;
  error?: string;
};

type DiscoveryOptions = {
  provider: unknown;
  apiKey?: unknown;
  baseUrl: unknown;
  model?: unknown;
  securityMode?: unknown;
  timeoutMs?: unknown;
  fetchImpl?: typeof fetch;
};

function modelIds(payload: unknown): string[] {
  const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  const ids = rows.map((item) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return String(row.id || row.name || row.model || '').trim();
  }).filter(Boolean);
  return [...new Set(ids)];
}

function safeError(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : String(error || 'connection failed');
  return (apiKey ? raw.replaceAll(apiKey, '[REDACTED]') : raw).slice(0, 400);
}

function isBlockedError(error: unknown): boolean {
  const candidate = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown }
    : {};
  return candidate.code === 'MODEL_PROVIDER_POLICY_DENIED'
    || /policy|blocked|needs approval/i.test(String(candidate.message || ''));
}

export async function discoverProviderModels({
  provider,
  apiKey: rawApiKey,
  baseUrl: rawBaseUrl,
  model: rawModel,
  securityMode,
  timeoutMs = 2000,
  fetchImpl = globalThis.fetch,
}: DiscoveryOptions): Promise<ModelDiscoveryResult> {
  const apiKey = String(rawApiKey || '').trim();
  const baseUrl = String(rawBaseUrl || '').trim().replace(/\/+$/, '');
  const model = String(rawModel || '').trim();
  const startedAt = Date.now();
  if (!baseUrl) {
    return { status: 'unreachable', models: [], latencyMs: 0, error: 'Base URL 未配置' };
  }
  const controller = new AbortController();
  const boundedTimeout = Math.min(15_000, Math.max(500, Number(timeoutMs) || 2000));
  const timeout = setTimeout(() => controller.abort(), boundedTimeout);
  try {
    const secureFetch = createModelEndpointFetch(
      { provider, baseUrl, model, securityMode },
      { fetchImpl },
    );
    const headers: Record<string, string> = { accept: 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const response = await secureFetch(`${baseUrl}/models`, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        status: 'unreachable',
        models: [],
        latencyMs: Date.now() - startedAt,
        error: `模型目录请求失败(HTTP ${response.status})`,
      };
    }
    const models = modelIds(await response.json());
    const modelAvailable = !model || models.includes(model);
    return {
      status: modelAvailable ? 'connected' : 'model_missing',
      models,
      modelAvailable,
      latencyMs: Date.now() - startedAt,
      ...(!modelAvailable ? { error: `当前模型「${model}」未安装或不可用` } : {}),
    };
  } catch (error) {
    const aborted = error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError';
    return {
      status: isBlockedError(error) ? 'blocked' : 'unreachable',
      models: [],
      latencyMs: Date.now() - startedAt,
      error: aborted ? `连接测试在 ${boundedTimeout}ms 后超时` : safeError(error, apiKey),
    };
  } finally {
    clearTimeout(timeout);
  }
}
