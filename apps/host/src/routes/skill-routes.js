import { sendJson, withJsonBody } from '../http/request-utils.js';

// Skill routes: list skills + toggle enable/disable.
//
//   GET  /api/skills              -> manifest + enabled state for every skill
//   POST /api/skills/:id/toggle   -> { enabled?: bool } (omit to flip), returns the skill
//
// Toggling is a settings change (idempotent by value), so it does not require an
// Idempotency-Key.

const TOGGLE_RE = /^\/api\/skills\/([a-zA-Z0-9_-]+)\/toggle$/;

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
        const next = body && typeof body.enabled === 'boolean' ? body.enabled : !skillRegistry.isEnabled(match[1]);
        const skill = skillRegistry.setEnabled(match[1], next);
        sendJson(response, 200, { context: requestContext, skill });
      } catch (err) {
        sendJson(response, err.statusCode || 400, { error: err.message });
      }
    });
    return true;
  }

  return false;
}
