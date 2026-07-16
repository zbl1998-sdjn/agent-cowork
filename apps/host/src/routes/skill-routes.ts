// 技能路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/skills/*(内置 recipe 技能:列出、按 id 开关)与
//       /api/skill-packs/*(SKILL.md 标准技能包:按工作区列出、按 name 开关,禁用名单持久化)。
// 依赖:L0 request-utils + L1 skills 注册表/技能包加载与启停(经参数注入或直连同域模块)。
// 导出:handleSkillRoutes。
import { z } from 'zod';
import { sendJson, withJsonBody } from '../http/request-utils.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import { requireGlobalMutationAdmin } from '../auth/global-mutation-admin.js';
import type { GlobalMutationAdminIdentity } from '../auth/global-mutation-admin.js';
import { discoverSkillPacks } from '../skills/skill-md-loader.js';
import { readDisabledSkillPacks, setSkillPackEnabled } from '../skills/skill-pack-settings.js';

type RouteRequest = HttpRequestLike & { method?: string };
type SkillRegistryLike = {
  list(): unknown[];
  isEnabled(id: string): boolean;
  setEnabled(id: string, enabled: boolean): unknown;
};
type RouteError = Error & { statusCode?: number };
type SkillRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestUrl?: URL;
  requestContext?: Record<string, unknown>;
  globalMutationAdmins: readonly GlobalMutationAdminIdentity[];
  skillRegistry?: SkillRegistryLike | null;
  safeTrustedRoot?: (input?: unknown) => string;
};

// 技能路由清单:
//   GET  /api/skills                    -> 返回每个技能的 manifest 与启用状态
//   POST /api/skills/:id/toggle         -> { enabled?: bool };省略 enabled 时取反并返回技能
//   GET  /api/skill-packs?root=…        -> 返回该工作区发现的 SKILL.md 技能包(含 enabled)与跳过原因
//   POST /api/skill-packs/:name/toggle  -> { enabled?: bool, root?: string };禁用名单按工作区持久化
// 开关技能属于设置变更,按目标值幂等,所以不要求 Idempotency-Key。

const TOGGLE_RE = /^\/api\/skills\/([a-zA-Z0-9_-]+)\/toggle$/;
const PACK_TOGGLE_RE = /^\/api\/skill-packs\/([a-z0-9-]+)\/toggle$/;

const skillPackToggleBodySchema = z.preprocess(
  (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  z.object({
    enabled: z.preprocess((value) => (typeof value === 'boolean' ? value : undefined), z.boolean().optional()),
    root: z.string().optional(),
  }),
);

function listSkillPacks(trustedRoot: string) {
  const { packs, warnings } = discoverSkillPacks(trustedRoot);
  const disabled = readDisabledSkillPacks(trustedRoot);
  return {
    packs: packs.map((pack) => ({ ...pack, enabled: !disabled.has(pack.name) })),
    warnings,
  };
}

const skillToggleBodySchema = z.preprocess(
  (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  z.object({
    enabled: z.preprocess((value) => (typeof value === 'boolean' ? value : undefined), z.boolean().optional()),
  }),
);

export async function handleSkillRoutes({
  request,
  response,
  pathname,
  requestUrl,
  requestContext,
  globalMutationAdmins,
  skillRegistry,
  safeTrustedRoot,
}: SkillRouteOptions): Promise<boolean> {
  if (typeof safeTrustedRoot === 'function') {
    if (request.method === 'GET' && pathname === '/api/skill-packs') {
      try {
        const trustedRoot = safeTrustedRoot(requestUrl?.searchParams.get('root') || undefined);
        sendJson(response, 200, { context: requestContext, ...listSkillPacks(trustedRoot) });
      } catch (err) {
        const error = err as RouteError;
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
      return true;
    }
    const packMatch = pathname.match(PACK_TOGGLE_RE);
    // 技能包启停是当前用户工作区级设置(经认证 + safeTrustedRoot 授权),不要求全局 admin;
    // recipe 技能的 /api/skills/:id/toggle 改的是 host 进程级单例,仍保留 admin 门禁。
    if (request.method === 'POST' && packMatch) {
      await withJsonBody(request, response, async (body) => {
        try {
          const input = skillPackToggleBodySchema.parse(body);
          const trustedRoot = safeTrustedRoot(input.root || undefined);
          const name = packMatch[1] ?? '';
          const disabled = readDisabledSkillPacks(trustedRoot);
          const next = typeof input.enabled === 'boolean' ? input.enabled : disabled.has(name);
          setSkillPackEnabled(trustedRoot, name, next);
          sendJson(response, 200, { context: requestContext, name, enabled: next, ...listSkillPacks(trustedRoot) });
        } catch (err) {
          const error = err as RouteError;
          sendJson(response, error.statusCode || 400, { error: error.message });
        }
      });
      return true;
    }
  }

  if (!skillRegistry) {
    return false;
  }

  if (request.method === 'GET' && pathname === '/api/skills') {
    sendJson(response, 200, { context: requestContext, skills: skillRegistry.list() });
    return true;
  }

  const match = pathname.match(TOGGLE_RE);
  if (request.method === 'POST' && match) {
    if (!requireGlobalMutationAdmin(response, requestContext || {}, globalMutationAdmins)) return true;
    await withJsonBody(request, response, async (body) => {
      try {
        const input = skillToggleBodySchema.parse(body);
        const skillId = match[1] ?? '';
        const next = typeof input.enabled === 'boolean' ? input.enabled : !skillRegistry.isEnabled(skillId);
        const skill = skillRegistry.setEnabled(skillId, next);
        sendJson(response, 200, { context: requestContext, skill });
      } catch (err) {
        const error = err as RouteError;
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    });
    return true;
  }

  return false;
}
