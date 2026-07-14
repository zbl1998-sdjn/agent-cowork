// Kimi 路由支撑(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:封装 Kimi 配置响应、provider 归一化、运行记录落盘与索引,保持主路由只做分支编排。
import { sendJson } from '../http/request-utils.js';
import type { HttpResponseLike, RequestContext } from '../http/request-utils.js';
import type { AgentModelConfig } from '../engine/api-runner-config.js';
import { composeFullModelId, normaliseModelProviderId } from '../engine/provider/catalog.js';
import { modelsDevProviderCatalogResponse } from '../engine/provider/models-dev-catalog.js';
import { inspectRouteModelConnection } from './agent-engine-route-connection.js';
import type { HostState } from '../runtime/host-state-types.js';
import type { streamChat } from '../engine/chat-stream.js';

type MemoryContext = { enabled?: boolean; bytes?: unknown; notes?: unknown; text?: string };
type MemoryStoreLike = {
  loadMemoryContext(root: string, options: { maxBytes: number; context: RequestContext }): MemoryContext;
};
type ModelRunnerResult = {
  ok?: unknown;
  text?: unknown;
  provider?: unknown;
  model?: unknown;
  usage?: unknown;
  durationMs?: number;
};
export type ModelRunner = (options: Record<string, unknown>) => Promise<ModelRunnerResult> | ModelRunnerResult;
type AgentConcurrencyLike = { tryAcquire(tenantId?: string): (() => void) | null };
type StreamChatRunner = Parameters<typeof streamChat>[0]['streamRunner'];

export type AgentEngineRouteState = HostState & {
  memoryStore: MemoryStoreLike;
  agentModelConfig: AgentModelConfig;
  modelApiEnabled?: boolean;
  modelPlanRunner: ModelRunner;
  modelChatRunner: ModelRunner;
  modelChatStreamRunner: StreamChatRunner;
  recomputeModelEnabled: () => unknown;
  persistModelConfig: () => void;
  indexRun: (record: Record<string, unknown>, context: RequestContext) => void;
  agentConcurrency: AgentConcurrencyLike;
};

type CatalogOptions = NonNullable<Parameters<typeof modelsDevProviderCatalogResponse>[0]>;
type CatalogFetchImpl = Exclude<CatalogOptions['fetchImpl'], undefined>;

export function modelProvider(modelConfig: unknown): string {
  const config = modelConfig && typeof modelConfig === 'object'
    ? modelConfig as { provider?: unknown }
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

function modelCatalogOptions(state: AgentEngineRouteState): CatalogOptions {
  const fetchImpl = state.config.fetchImpl;
  return typeof fetchImpl === 'function'
    ? { fetchImpl: fetchImpl as CatalogFetchImpl }
    : {};
}

export async function sendAgentEngineInfo(response: HttpResponseLike, state: AgentEngineRouteState): Promise<void> {
  const provider = modelProvider(state.agentModelConfig);
  state.recomputeModelEnabled();
  const { activeState, connectionResult, providerStates } = await inspectRouteModelConnection(
    state.agentModelConfig,
    provider,
    state.config.fetchImpl,
  );
  if (connectionResult && connectionResult.connection.status !== 'connected') state.modelApiEnabled = false;
  const catalog = await modelsDevProviderCatalogResponse(modelCatalogOptions(state));
  sendJson(response, 200, {
    provider,
    configured: activeState.configured,
    planEnabled: state.modelApiEnabled,
    chatEnabled: state.modelApiEnabled,
    baseUrl: state.agentModelConfig.baseUrl,
    model: state.agentModelConfig.model,
    fullModelId: state.agentModelConfig.fullModelId || composeFullModelId(provider, state.agentModelConfig.model),
    modelIdFormat: catalog.modelIdFormat,
    providers: catalog.providers,
    catalog: catalog.catalog,
    catalogSource: catalog.source,
    fallbacks: fallbackSummaries(state.agentModelConfig.fallbacks),
    hasKey: activeState.hasKey,
    providerStates,
    availableModels: connectionResult?.models || [],
    connection: connectionResult?.connection || null,
  });
}

export async function sendModelProviderCatalog(response: HttpResponseLike, state: AgentEngineRouteState): Promise<void> {
  const provider = modelProvider(state.agentModelConfig);
  sendJson(response, 200, {
    ...await modelsDevProviderCatalogResponse(modelCatalogOptions(state)),
    current: {
      provider,
      model: state.agentModelConfig.model,
      fullModelId: state.agentModelConfig.fullModelId || composeFullModelId(provider, state.agentModelConfig.model),
      baseUrl: state.agentModelConfig.baseUrl,
      configured: state.agentModelConfig.configured,
      hasKey: Boolean(state.agentModelConfig.apiKey),
    },
  });
}
