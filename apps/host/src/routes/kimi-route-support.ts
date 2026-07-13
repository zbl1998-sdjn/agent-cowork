// Kimi 路由支撑(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:封装 Kimi 配置响应、provider 归一化、运行记录落盘与索引,保持主路由只做分支编排。
import { sendJson } from '../http/request-utils.js';
import type { HttpResponseLike, RequestContext } from '../http/request-utils.js';
import type { KimiApiConfig } from '../engine/api-runner-config.js';
import { composeFullModelId, normaliseModelProviderId } from '../engine/provider/catalog.js';
import { modelsDevProviderCatalogResponse } from '../engine/provider/models-dev-catalog.js';
import { inspectRouteModelConnection } from './kimi-route-connection.js';
import type { HostState } from '../runtime/host-state-types.js';
import type { streamChat } from '../engine/chat-stream.js';

type MemoryContext = { enabled?: boolean; bytes?: unknown; notes?: unknown; text?: string };
type MemoryStoreLike = {
  loadMemoryContext(root: string, options: { maxBytes: number; context: RequestContext }): MemoryContext;
};
type KimiRunnerResult = {
  ok?: unknown;
  text?: unknown;
  provider?: unknown;
  model?: unknown;
  usage?: unknown;
  durationMs?: number;
};
export type KimiRunner = (options: Record<string, unknown>) => Promise<KimiRunnerResult> | KimiRunnerResult;
type AgentConcurrencyLike = { tryAcquire(tenantId?: string): (() => void) | null };
type StreamChatRunner = Parameters<typeof streamChat>[0]['streamRunner'];

export type KimiRouteState = HostState & {
  memoryStore: MemoryStoreLike;
  kimiApiConfig: KimiApiConfig;
  kimiApiEnabled?: boolean;
  kimiPlanRunner: KimiRunner;
  kimiChatRunner: KimiRunner;
  kimiChatStreamRunner: StreamChatRunner;
  recomputeKimiEnabled: () => unknown;
  persistKimiConfig: () => void;
  indexRun: (record: Record<string, unknown>, context: RequestContext) => void;
  agentConcurrency: AgentConcurrencyLike;
};

type CatalogOptions = NonNullable<Parameters<typeof modelsDevProviderCatalogResponse>[0]>;
type CatalogFetchImpl = Exclude<CatalogOptions['fetchImpl'], undefined>;

export function modelProvider(kimiConfig: unknown): string {
  const config = kimiConfig && typeof kimiConfig === 'object'
    ? kimiConfig as { provider?: unknown }
    : {};
  return normaliseModelProviderId(config.provider, 'kimi-api');
}
function fallbackSummaries(value: unknown): Array<{ provider: string; baseUrl: unknown; model: unknown; hasKey: boolean }> {
  return Array.isArray(value)
    ? value.map((item) => {
      const fallback = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return {
        provider: modelProvider(fallback),
        baseUrl: fallback.baseUrl,
        model: fallback.model,
        hasKey: Boolean(fallback.apiKey),
      };
    })
    : [];
}

function modelCatalogOptions(state: KimiRouteState): CatalogOptions {
  const fetchImpl = state.config.fetchImpl;
  return typeof fetchImpl === 'function'
    ? { fetchImpl: fetchImpl as CatalogFetchImpl }
    : {};
}

export async function sendKimiInfo(response: HttpResponseLike, state: KimiRouteState): Promise<void> {
  const provider = modelProvider(state.kimiApiConfig);
  state.recomputeKimiEnabled();
  const { activeState, connectionResult, providerStates } = await inspectRouteModelConnection(
    state.kimiApiConfig,
    provider,
    state.config.fetchImpl,
  );
  if (connectionResult && connectionResult.connection.status !== 'connected') state.kimiApiEnabled = false;
  const catalog = await modelsDevProviderCatalogResponse(modelCatalogOptions(state));
  sendJson(response, 200, {
    provider,
    configured: activeState.configured,
    planEnabled: state.kimiApiEnabled,
    chatEnabled: state.kimiApiEnabled,
    baseUrl: state.kimiApiConfig.baseUrl,
    model: state.kimiApiConfig.model,
    fullModelId: state.kimiApiConfig.fullModelId || composeFullModelId(provider, state.kimiApiConfig.model),
    modelIdFormat: catalog.modelIdFormat,
    providers: catalog.providers,
    catalog: catalog.catalog,
    catalogSource: catalog.source,
    fallbacks: fallbackSummaries(state.kimiApiConfig.fallbacks),
    hasKey: activeState.hasKey,
    providerStates,
    availableModels: connectionResult?.models || [],
    connection: connectionResult?.connection || null,
  });
}

export async function sendModelProviderCatalog(response: HttpResponseLike, state: KimiRouteState): Promise<void> {
  const provider = modelProvider(state.kimiApiConfig);
  sendJson(response, 200, {
    ...await modelsDevProviderCatalogResponse(modelCatalogOptions(state)),
    current: {
      provider,
      model: state.kimiApiConfig.model,
      fullModelId: state.kimiApiConfig.fullModelId || composeFullModelId(provider, state.kimiApiConfig.model),
      baseUrl: state.kimiApiConfig.baseUrl,
      configured: state.kimiApiConfig.configured,
      hasKey: Boolean(state.kimiApiConfig.apiKey),
    },
  });
}
