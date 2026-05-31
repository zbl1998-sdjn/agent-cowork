// 引导 API(UI · lib/api 传输层):封装 /api/onboarding/* —— 取按角色的配方/连接器推荐。
import { postJson, type PostBody } from './transport';
import type { OnboardingResponse } from '../onboarding';

export interface OnboardingRecommendationRequest extends PostBody {
  role?: string;
  workspaceType?: string;
}

export function getOnboardingRecommendations(body: OnboardingRecommendationRequest): Promise<OnboardingResponse> {
  return postJson<OnboardingResponse>('/api/onboarding/recommendations', body);
}
