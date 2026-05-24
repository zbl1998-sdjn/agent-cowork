import { sendJson, withJsonBody } from '../http/request-utils.js';
import { createPromptRefiner } from '../kimi/prompt/refiner.js';
import { createUserProfile } from '../memory/profile.js';

function contextFromBody(body, requestContext, trustedRoot) {
  const supplied = body && typeof body.context === 'object' && !Array.isArray(body.context)
    ? body.context
    : {};
  return {
    ...supplied,
    trustedRoot,
    tenantId: requestContext.tenantId,
    userId: requestContext.userId,
    traceId: requestContext.traceId,
  };
}

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
      project: ctx.project || recalled.project || '',
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

export async function handlePromptRoutes({ request, response, pathname, requestContext, state }) {
  if (request.method !== 'POST' || pathname !== '/api/prompt/refine') {
    return false;
  }

  await withJsonBody(request, response, async (body) => {
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    const trustedRoot = state.safeTrustedRoot(body?.trustedRoot || state.trustedRootDefault);
    const refiner = state.config.promptRefiner || createPromptRefiner({
      modelCall: state.config.promptRefineModelCall,
      timeoutMs: state.config.promptRefineTimeoutMs,
    });
    const ctx = await contextWithProfile(body, requestContext, trustedRoot, state.memoryStore, prompt);
    const result = await refiner.refine(prompt, ctx);
    sendJson(response, 200, {
      ...result,
      trustedRoot,
      context: requestContext,
    });
  });
  return true;
}
