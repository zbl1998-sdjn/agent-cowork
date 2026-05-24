import { useCallback, useState } from 'react';
import { refinePrompt, type PromptRefineContext, type PromptRefineResult } from '../lib/api/prompt';

export interface PromptRefineState {
  loading: boolean;
  result: PromptRefineResult | null;
  error: string | null;
}

export function usePromptRefine(opts: { trustedRoot?: string; context?: PromptRefineContext } = {}) {
  const [state, setState] = useState<PromptRefineState>({
    loading: false,
    result: null,
    error: null,
  });

  const refine = useCallback(async (prompt: string) => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const result = await refinePrompt(prompt, opts);
      setState({ loading: false, result, error: null });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : '提示优化失败';
      setState({ loading: false, result: null, error: message });
      return null;
    }
  }, [opts]);

  const clear = useCallback(() => {
    setState({ loading: false, result: null, error: null });
  }, []);

  return { ...state, refine, clear };
}
