// 引导 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:按角色/工作区类型拉取上手推荐(配方/连接器),响应类型复用 lib/onboarding。
// 依赖/对应路由:POST /api/onboarding/recommendations。导出:getOnboardingRecommendations + OnboardingRecommendationRequest 类型。
import { postJson, type PostBody } from './transport';
import type { OnboardingResponse } from '../onboarding';

export interface OnboardingRecommendationRequest extends PostBody {
  role?: string;
  workspaceType?: string;
}

export function getOnboardingRecommendations(body: OnboardingRecommendationRequest): Promise<OnboardingResponse> {
  return postJson<OnboardingResponse>('/api/onboarding/recommendations', body);
}
