import { getJson, postJson, type PostBody } from './transport';

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
