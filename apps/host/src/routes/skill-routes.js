import { sendJson, withJsonBody } from '../http/request-utils.js';

/** @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest */
/** @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse */
/** @typedef {{ list(): unknown[], isEnabled(id: string): boolean, setEnabled(id: string, enabled: boolean): unknown }} SkillRegistryLike */
/** @typedef {Error & { statusCode?: number }} RouteError */

// Skill routes: list skills + toggle enable/disable.
//
//   GET  /api/skills              -> manifest + enabled state for every skill
//   POST /api/skills/:id/toggle   -> { enabled?: bool } (omit to flip), returns the skill
//
// Toggling is a settings change (idempotent by value), so it does not require an
// Idempotency-Key.

const TOGGLE_RE = /^\/api\/skills\/([a-zA-Z0-9_-]+)\/toggle$/;

/** @param {{ request: RouteRequest, response: RouteResponse, pathname: string, requestContext?: Record<string, unknown>, skillRegistry?: SkillRegistryLike | null }} options */
export async function handleSkillRoutes({ request, response, pathname, requestContext, skillRegistry }) {
  if (!skillRegistry) {
    return false;
  }

  if (request.method === 'GET' && pathname === '/api/skills') {
    sendJson(response, 200, { context: requestContext, skills: skillRegistry.list() });
    return true;
  }

  const match = pathname.match(TOGGLE_RE);
  if (request.method === 'POST' && match) {
    await withJsonBody(request, response, async (body) => {
      try {
        const input = /** @type {{ enabled?: unknown }} */ (body || {});
        const next = typeof input.enabled === 'boolean' ? input.enabled : !skillRegistry.isEnabled(match[1]);
        const skill = skillRegistry.setEnabled(match[1], next);
        sendJson(response, 200, { context: requestContext, skill });
      } catch (err) {
        const error = /** @type {RouteError} */ (err);
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    });
    return true;
  }

  return false;
}
