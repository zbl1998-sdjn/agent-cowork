import { useCallback } from 'react';
import { captureRecipeDraft } from '../lib/api';
import type { AssistantMessage, RecipeCaptureResponse } from '../lib/app-types';

interface RecipeCaptureOptions {
  patchAssistant: (id: string, patch: (message: AssistantMessage) => AssistantMessage) => void;
}

export function useRecipeCapture({ patchAssistant }: RecipeCaptureOptions) {
  return useCallback(async (assistantId: string, runId: string) => {
    const sourceRunId = runId.trim();
    if (!sourceRunId) return;
    patchAssistant(assistantId, (message) => ({
      ...message,
      recipeCaptureStatus: 'capturing',
      recipeCaptureError: undefined,
    }));
    try {
      const response = await captureRecipeDraft<RecipeCaptureResponse>(sourceRunId);
      patchAssistant(assistantId, (message) => ({
        ...message,
        recipeDraft: response.recipe,
        recipeCaptureStatus: 'captured',
        recipeCaptureError: undefined,
      }));
    } catch (error) {
      patchAssistant(assistantId, (message) => ({
        ...message,
        recipeCaptureStatus: 'failed',
        recipeCaptureError: (error as Error).message || '保存技能草稿失败',
      }));
    }
  }, [patchAssistant]);
}
