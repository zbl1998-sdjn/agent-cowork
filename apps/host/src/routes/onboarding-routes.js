import { sendJson, withJsonBody } from '../http/request-utils.js';
import { buildOnboardingRecommendations } from '../onboarding/recommendations.js';

export async function handleOnboardingRoutes({ request, response, pathname }) {
  if (request.method === 'POST' && pathname === '/api/onboarding/recommendations') {
    await withJsonBody(request, response, async (body) => {
      sendJson(response, 200, buildOnboardingRecommendations(body));
    });
    return true;
  }

  return false;
}
