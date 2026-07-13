// Kimi 路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/kimi/* —— Kimi 配置读写、CLI 探测、以及把对话请求接到流式聊天(SSE)。
// 依赖:L1 kimi(chat-stream/config-store/cli-* 等,经 state 注入)。导出:handleKimiRoutes。
import { streamChat } from '../kimi/chat-stream.js';
import { streamAgentChat } from './agent-stream.js';
import { KIMI_API_NOT_CONFIGURED_MESSAGE } from '../kimi/api-runner.js';
import { sendJson, withJsonBody } from '../http/request-utils.js';
import { omitUndefined } from '../util/object.js';
import { hasSessionModelAccess } from './session-model-config.js';
import { modelProvider, sendKimiInfo, sendModelProviderCatalog, type KimiRouteState } from './kimi-route-support.js';
import { runKimiAndRecord } from './kimi-route-records.js';
import {
  splitFullModelId,
} from '../kimi/provider/catalog.js';
import {
  activateProviderProfile,
  cloneProviderProfiles,
  syncActiveProviderProfile,
} from '../kimi/provider-profiles.js';
import {
  kimiAgentStreamBodySchema,
  kimiChatStreamBodySchema,
  kimiConfigBodySchema,
  kimiPlanChatBodySchema,
  kimiTestBodySchema,
  normalizeKimiFallbacks,
  parseKimiBody,
} from './kimi-route-schemas.js';
import type { HttpRequestLike, HttpResponseLike, RequestContext } from '../http/request-utils.js';
import type { HostState } from '../runtime/host-state-types.js';
import { requireGlobalMutationAdmin } from '../auth/global-mutation-admin.js';
import { testModelConnection } from '../kimi/model-connection-test.js';

type RouteRequest = HttpRequestLike & { method?: string };
type KimiRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestContext: RequestContext;
  state: HostState;
  safeTrustedRoot(input?: unknown): string;
};

function hasLocalModelConfigSelfService(
  state: HostState,
  requestContext: RequestContext,
): boolean {
  return state.allowLocalModelConfigSelfService === true
    && state.requireAuth === true
    && state.trustIdentityHeaders !== true
    && requestContext.authenticated === true;
}

export async function handleKimiRoutes({
  request,
  response,
  pathname,
  requestContext,
  state,
  safeTrustedRoot,
}: KimiRouteOptions): Promise<boolean> {
  const routeState = state as KimiRouteState;

  if (request.method === 'GET' && pathname === '/api/models/providers') {
    await sendModelProviderCatalog(response, routeState);
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/kimi/config') {
    if (
      !hasLocalModelConfigSelfService(state, requestContext)
      && !requireGlobalMutationAdmin(response, requestContext, state.globalMutationAdmins)
    ) return true;
    await withJsonBody(request, response, async (body) => {
      const input = parseKimiBody(response, kimiConfigBodySchema, body, 'invalid kimi config request');
      if (!input) return;
      const previousConfig = {
        ...routeState.kimiApiConfig,
        fallbacks: routeState.kimiApiConfig.fallbacks.map((fallback) => ({ ...fallback })),
        providerProfiles: cloneProviderProfiles(routeState.kimiApiConfig.providerProfiles),
      };
      const previousEnabled = routeState.kimiApiEnabled;
      const previousProvider = modelProvider(routeState.kimiApiConfig);
      const parsedModel = splitFullModelId(input.model);
      const requestedProvider = input.provider?.trim()
        ? modelProvider(input)
        : parsedModel.provider || previousProvider;
      if (requestedProvider !== previousProvider) {
        activateProviderProfile(routeState.kimiApiConfig, requestedProvider);
      }
      if (input.clearKey === true) routeState.kimiApiConfig.apiKey = '';
      else if (input.apiKey?.trim()) routeState.kimiApiConfig.apiKey = input.apiKey.trim();
      if (input.fallbacks) routeState.kimiApiConfig.fallbacks = normalizeKimiFallbacks(input.fallbacks);
      if (input.baseUrl?.trim()) routeState.kimiApiConfig.baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
      if (input.model?.trim()) {
        routeState.kimiApiConfig.model = parsedModel.provider && (!input.provider?.trim() || parsedModel.provider === modelProvider(routeState.kimiApiConfig))
          ? parsedModel.model
          : input.model.trim();
      }
      syncActiveProviderProfile(routeState.kimiApiConfig);
      routeState.recomputeKimiEnabled();
      try {
        routeState.persistKimiConfig();
      } catch {
        Object.assign(routeState.kimiApiConfig, previousConfig);
        if (previousEnabled === undefined) delete routeState.kimiApiEnabled;
        else routeState.kimiApiEnabled = previousEnabled;
        sendJson(response, 500, { error: 'Failed to persist Kimi config' });
        return;
      }
      await sendKimiInfo(response, routeState);
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/kimi/info') {
    await sendKimiInfo(response, routeState);
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/kimi/test') {
    await withJsonBody(request, response, async (body) => {
      const input = parseKimiBody(response, kimiTestBodySchema, body, 'invalid kimi test request');
      if (!input) return;
      const fetchImpl = typeof routeState.config.fetchImpl === 'function'
        ? routeState.config.fetchImpl as typeof fetch
        : undefined;
      sendJson(response, 200, await testModelConnection(
        routeState.kimiApiConfig,
        omitUndefined(input),
        fetchImpl,
      ));
    });
    return true;
  }

  if (request.method === 'POST' && (pathname === '/api/kimi/plan' || pathname === '/api/kimi/chat')) {
    await withJsonBody(request, response, async (body) => {
      const input = parseKimiBody(response, kimiPlanChatBodySchema, body, 'invalid kimi request');
      if (!input) return;
      if (!routeState.kimiApiEnabled) {
        sendJson(response, 503, { error: KIMI_API_NOT_CONFIGURED_MESSAGE });
        return;
      }
      const isPlan = pathname === '/api/kimi/plan';
      await runKimiAndRecord({
        state: routeState,
        type: isPlan ? 'kimi-plan' : 'kimi-chat',
        mode: isPlan && input.mode === 'code' ? 'code' : isPlan ? 'cowork' : 'chat',
        trustedRoot: safeTrustedRoot(input.trustedRoot),
        prompt: input.prompt,
        summary: input.summary,
        runner: isPlan ? routeState.kimiPlanRunner : routeState.kimiChatRunner,
        response,
        context: requestContext,
      });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/agent/chat/stream') {
    await withJsonBody(request, response, async (body) => {
      const input = parseKimiBody(response, kimiAgentStreamBodySchema, body, 'invalid agent stream request');
      if (!input) return;
      if (!routeState.kimiApiEnabled && !hasSessionModelAccess(input)) {
        sendJson(response, 503, { error: KIMI_API_NOT_CONFIGURED_MESSAGE });
        return;
      }
      const hasPrompt = typeof input.prompt === 'string' && input.prompt.trim();
      const hasResumeRunId = typeof input.resumeRunId === 'string' && input.resumeRunId.trim();
      if (!hasPrompt && !hasResumeRunId) {
        sendJson(response, 400, { error: 'body.prompt or body.resumeRunId is required' });
        return;
      }
      if (routeState.draining) {
        sendJson(response, 503, { error: '服务正在停机，暂不接受新任务。', context: requestContext });
        return;
      }
      const releaseSlot = routeState.agentConcurrency.tryAcquire(requestContext.tenantId);
      if (!releaseSlot) {
        sendJson(response, 429, { error: '并发运行数已达上限，请稍后重试。', context: requestContext });
        return;
      }
      try {
        // HostState 仍保留若干运行时注入槽为 unknown; 这里把松散 state 适配到流式 Agent 模块的窄契约。
        await streamAgentChat({
          response,
          request,
          requestContext,
          body: input,
          kimiConfig: routeState.kimiApiConfig,
          trustedRoot: safeTrustedRoot(input.trustedRoot),
          runStoreRoot: routeState.runStoreRoot,
          runsIndex: routeState.runsIndex,
          runEvents: routeState.runEvents,
          sandbox: routeState.sandboxEnabled ? routeState.sandbox : null,
          sandboxLimits: routeState.sandboxLimits,
          modelCall: routeState.config.agentModelCall,
          toolRegistry: routeState.toolRegistry,
          skillRegistry: routeState.skillRegistry,
          approvals: routeState.approvalRegistry,
          cancellation: routeState.cancellation,
          scheduler: routeState.activeScheduler,
        } as unknown as Parameters<typeof streamAgentChat>[0]);
      } finally {
        releaseSlot();
      }
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/kimi/chat/stream') {
    await withJsonBody(request, response, async (body) => {
      const input = parseKimiBody(response, kimiChatStreamBodySchema, body, 'invalid kimi stream request');
      if (!input) return;
      if (!routeState.kimiApiEnabled) {
        sendJson(response, 503, { error: KIMI_API_NOT_CONFIGURED_MESSAGE });
        return;
      }
      await streamChat({
        response,
        requestContext,
        body: input,
        streamRunner: routeState.kimiChatStreamRunner,
        cancellation: routeState.cancellation,
        kimiConfig: routeState.kimiApiConfig,
        trustedRoot: safeTrustedRoot(input.trustedRoot),
        runStoreRoot: routeState.runStoreRoot,
        runsIndex: routeState.runsIndex,
        fetchImpl: routeState.config.fetchImpl,
      } as unknown as Parameters<typeof streamChat>[0]);
    });
    return true;
  }
  return false;
}
