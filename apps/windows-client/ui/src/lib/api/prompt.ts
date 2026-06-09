// 提示词精炼 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:把用户草稿交给 host 精炼器做提示词优化,返回改写结果与缺失项。
// 依赖/对应路由:/api/prompt/refine。导出:refinePrompt、PromptRefineContext/PromptRefineResult 类型。
import { postJson } from './transport';

export interface PromptRefineContext {
  project?: string;
  profile?: {
    terms?: string[];
  };
  [key: string]: unknown;
}

export interface PromptRefineResult {
  refined: string;
  changed: boolean;
  needsClarification?: boolean;
  intent: string;
  missing: string[];
  trustedRoot?: string;
}

export async function refinePrompt(
  prompt: string,
  opts: { trustedRoot?: string; context?: PromptRefineContext } = {},
): Promise<PromptRefineResult> {
  return postJson('/api/prompt/refine', {
    prompt,
    trustedRoot: opts.trustedRoot,
    context: opts.context,
  });
}
