// 提示词 API(UI · lib/api 传输层):封装 /api/prompt/* —— 把用户草稿交给精炼器做提示词优化。
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
