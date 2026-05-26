import { sendJson, withJsonBody } from '../http/request-utils.js';
import { createPromptRefiner } from '../kimi/prompt/refiner.js';
import { createUserProfile } from '../memory/profile.js';

/**
 * @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest
 * @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse
 * @typedef {import('../kimi/prompt/refiner.js').PromptRefiner} PromptRefiner
 * @typedef {import('../memory/profile.js').MemoryStoreLike} MemoryStoreLike
 * @typedef {{ tenantId?: string, userId?: string, traceId?: string, [key: string]: unknown }} RequestContext
 * @typedef {{ terms?: unknown[], project?: unknown, entries?: unknown[] }} ProfileContext
 * @typedef {{ profile?: ProfileContext | null, userProfile?: ProfileContext | null, project?: unknown, trustedRoot: string, tenantId?: string, userId?: string, traceId?: string, [key: string]: unknown }} PromptContext
 * @typedef {{ prompt?: unknown, trustedRoot?: unknown, context?: unknown }} PromptBody
 * @typedef {{ promptRefiner?: PromptRefiner, promptRefineModelCall?: import('../kimi/prompt/refiner.js').PromptModelCall, promptRefineTimeoutMs?: number }} PromptConfig
 * @typedef {{ trustedRootDefault?: string, safeTrustedRoot(input?: unknown): string, config: PromptConfig, memoryStore?: MemoryStoreLike | null }} PromptRouteState
 * @typedef {{ request: RouteRequest, response: RouteResponse, pathname: string, requestContext: RequestContext, state: PromptRouteState }} PromptRouteOptions
 */

/** @param {PromptBody} body @param {RequestContext} requestContext @param {string} trustedRoot @returns {PromptContext} */
function contextFromBody(body, requestContext, trustedRoot) {
  const supplied = body && typeof body.context === 'object' && !Array.isArray(body.context)
    ? /** @type {Record<string, unknown>} */ (body.context)
    : {};
  return {
    ...supplied,
    trustedRoot,
    tenantId: requestContext.tenantId,
    userId: requestContext.userId,
    traceId: requestContext.traceId,
  };
}

/** @param {PromptBody} body @param {RequestContext} requestContext @param {string} trustedRoot @param {MemoryStoreLike | null | undefined} memoryStore @param {string} prompt @returns {Promise<PromptContext>} */
async function contextWithProfile(body, requestContext, trustedRoot, memoryStore, prompt) {
  const ctx = contextFromBody(body, requestContext, trustedRoot);
  const suppliedProfile = ctx.profile && typeof ctx.profile === 'object' ? ctx.profile : {};
  if (!memoryStore) return ctx;
  try {
    const recalled = await createUserProfile({ memoryStore }).recall(trustedRoot, {
      query: prompt,
      context: requestContext,
    });
    const terms = [
      ...(Array.isArray(recalled.terms) ? recalled.terms : []),
      ...(Array.isArray(suppliedProfile.terms) ? suppliedProfile.terms : []),
    ].filter(Boolean);
    return {
      ...ctx,
      project: typeof ctx.project === 'string' && ctx.project ? ctx.project : recalled.project || '',
      profile: {
        ...suppliedProfile,
        terms: Array.from(new Set(terms)).slice(0, 12),
        entries: recalled.entries,
      },
    };
  } catch {
    return ctx;
  }
}

/** @param {PromptRouteOptions} options @returns {Promise<boolean>} */
export async function handlePromptRoutes({ request, response, pathname, requestContext, state }) {
  if (request.method !== 'POST' || pathname !== '/api/prompt/refine') {
    return false;
  }

  await withJsonBody(request, response, async (body) => {
    const input = /** @type {PromptBody} */ (body || {});
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    const trustedRoot = state.safeTrustedRoot(input.trustedRoot || state.trustedRootDefault);
    const refiner = state.config.promptRefiner || createPromptRefiner({
      modelCall: state.config.promptRefineModelCall,
      timeoutMs: state.config.promptRefineTimeoutMs,
    });
    const ctx = await contextWithProfile(input, requestContext, trustedRoot, state.memoryStore, prompt);
    const result = await refiner.refine(prompt, ctx);
    sendJson(response, 200, {
      ...result,
      trustedRoot,
      context: requestContext,
    });
  });
  return true;
}
