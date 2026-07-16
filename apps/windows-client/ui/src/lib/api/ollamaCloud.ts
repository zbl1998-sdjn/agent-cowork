// Ollama Cloud API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:一键登录 Ollama 云(取设备配对 URL)、拉取云端模型、读推荐模型列表。
// 对应路由:/api/ollama-cloud/{signin,pull,recommended}。
import { getJson, postJson } from './transport';

export async function ollamaCloudRecommended(): Promise<string[]> {
  const res = await getJson<{ models?: unknown }>('/api/ollama-cloud/recommended');
  return Array.isArray(res.models) ? res.models.map((m) => String(m)).filter(Boolean) : [];
}

export async function ollamaCloudSignin(): Promise<{ connectUrl: string | null; output: string }> {
  const res = await postJson<{ connectUrl?: unknown; output?: unknown }>('/api/ollama-cloud/signin', {});
  return { connectUrl: typeof res.connectUrl === 'string' ? res.connectUrl : null, output: String(res.output || '') };
}

export async function ollamaCloudPull(model: string): Promise<{ model: string; output: string }> {
  const res = await postJson<{ model?: unknown; output?: unknown }>('/api/ollama-cloud/pull', { model });
  return { model: String(res.model || model), output: String(res.output || '') };
}
