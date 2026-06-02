// 配方 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:封装配方相关 host 调用——列出、运行、捕获草稿、保存自定义配方(写操作带幂等键)。
// 对应路由:/api/recipes、/api/recipes/:id/run、/api/recipes/capture、/api/recipes/custom。
// 导出:listRecipes、runRecipe、captureRecipeDraft、saveCustomRecipe。
import { getJson, newIdempotencyKey, postJson, type PostBody } from './transport';

export async function listRecipes<TRecipe = unknown>(): Promise<TRecipe[]> {
  const res = await getJson<{ recipes: TRecipe[] }>('/api/recipes');
  return res.recipes || [];
}

export async function runRecipe<TResponse = unknown>(
  recipeId: string,
  body: PostBody,
): Promise<TResponse> {
  return postJson<TResponse>(`/api/recipes/${encodeURIComponent(recipeId)}/run`, body);
}

export async function captureRecipeDraft<TResponse = unknown>(runId: string): Promise<TResponse> {
  return postJson<TResponse>('/api/recipes/capture', { runId });
}

export async function saveCustomRecipe<TResponse = unknown>(recipe: unknown): Promise<TResponse> {
  return postJson<TResponse>('/api/recipes/custom', { recipe, idempotencyKey: newIdempotencyKey('recipe-save') });
}
