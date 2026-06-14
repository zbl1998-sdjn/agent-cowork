// 提示词路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/prompt/* —— 智能输入相关:把用户草稿交给精炼器(refiner)做提示词优化/改写。
// 依赖:L0 request-utils + L1 kimi/prompt 精炼器(经 state 注入)。导出:handlePromptRoutes。
import { z } from 'zod';
import { sendJson, withJsonBody } from '../http/request-utils.js';
import { createPromptRefiner } from '../kimi/prompt/refiner.js';
import { createUserProfile } from '../memory/profile.js';
import { omitUndefined } from '../util/object.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import type { PromptContext, PromptModelCall, PromptRefiner } from '../kimi/prompt/refiner.js';
import type { MemoryStoreLike } from '../memory/profile.js';

type RouteRequest = HttpRequestLike & { method?: string };
type RequestContext = { tenantId?: string; userId?: string; traceId?: string; [key: string]: unknown };
type ProfileContext = { terms?: unknown[]; project?: unknown; entries?: unknown[] };
type PromptBody = {
  prompt: string;
  trustedRoot?: unknown;
  context: Record<string, unknown>;
};
type PromptConfig = {
  promptRefiner?: PromptRefiner;
  promptRefineModelCall?: PromptModelCall;
  promptRefineTimeoutMs?: number;
};
type PromptRouteState = {
  trustedRootDefault?: string;
  safeTrustedRoot(input?: unknown): string;
  config: PromptConfig;
  memoryStore?: MemoryStoreLike | null;
};
type PromptRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestContext: RequestContext;
  state: PromptRouteState;
};

const recordSchema = z.record(z.string(), z.unknown());
const MAX_PROMPT_LENGTH = 16_000;

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const promptRefineBodySchema = z.preprocess(
  objectOrEmpty,
  z.object({
    prompt: z.string()
      .trim()
      .min(1, 'prompt is required')
      .max(MAX_PROMPT_LENGTH, 'prompt is too long'),
    trustedRoot: z.unknown().optional(),
    // context 是可选用户元数据;边界保持宽容,但拒绝数组/标量把数字键泄漏进 refiner。
    context: z.preprocess(objectOrEmpty, recordSchema),
  }).loose(),
);

function contextFromBody(body: PromptBody, requestContext: RequestContext, trustedRoot: string): PromptContext {
  return omitUndefined({
    ...body.context,
    trustedRoot,
    tenantId: requestContext.tenantId,
    userId: requestContext.userId,
    traceId: requestContext.traceId,
  });
}

async function contextWithProfile(
  body: PromptBody,
  requestContext: RequestContext,
  trustedRoot: string,
  memoryStore: MemoryStoreLike | null | undefined,
  prompt: string,
): Promise<PromptContext> {
  const ctx = contextFromBody(body, requestContext, trustedRoot);
  const suppliedProfile: ProfileContext = ctx.profile && typeof ctx.profile === 'object'
    ? ctx.profile as ProfileContext
    : {};
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

export async function handlePromptRoutes({
  request,
  response,
  pathname,
  requestContext,
  state,
}: PromptRouteOptions): Promise<boolean> {
  if (request.method !== 'POST' || pathname !== '/api/prompt/refine') {
    return false;
  }

  await withJsonBody(request, response, async (body) => {
    const parsed = promptRefineBodySchema.safeParse(body);
    if (!parsed.success) {
      sendJson(response, 400, { error: parsed.error.issues[0]?.message || 'invalid prompt request' });
      return;
    }
    const input = parsed.data;
    const trustedRoot = state.safeTrustedRoot(input.trustedRoot || state.trustedRootDefault);
    const refiner = state.config.promptRefiner || createPromptRefiner(omitUndefined({
      modelCall: state.config.promptRefineModelCall,
      timeoutMs: state.config.promptRefineTimeoutMs,
    }));
    const ctx = await contextWithProfile(input, requestContext, trustedRoot, state.memoryStore, input.prompt);
    const result = await refiner.refine(input.prompt, ctx);
    sendJson(response, 200, {
      ...result,
      trustedRoot,
      context: requestContext,
    });
  });
  return true;
}
