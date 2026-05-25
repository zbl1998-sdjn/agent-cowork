import { postJson, type PostBody } from './transport';
import type { OnboardingResponse } from '../onboarding';

export interface OnboardingRecommendationRequest extends PostBody {
  role?: string;
  workspaceType?: string;
}

export function getOnboardingRecommendations(body: OnboardingRecommendationRequest): Promise<OnboardingResponse> {
  return postJson<OnboardingResponse>('/api/onboarding/recommendations', body);
}
