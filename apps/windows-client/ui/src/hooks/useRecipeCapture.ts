import { useCallback } from 'react';
import { captureRecipeDraft, saveCustomRecipe } from '../lib/api';
import type { AssistantMessage, RecipeCaptureResponse, RecipeSaveResponse } from '../lib/app-types';

interface RecipeCaptureOptions {
  patchAssistant: (id: string, patch: (message: AssistantMessage) => AssistantMessage) => void;
  onRecipeSaved?: (recipe: { id: string; name: string; summary?: string }) => void;
}

export function useRecipeCapture({ patchAssistant, onRecipeSaved }: RecipeCaptureOptions) {
  return useCallback(async (assistantId: string, runId: string) => {
    const sourceRunId = runId.trim();
    if (!sourceRunId) return;
    patchAssistant(assistantId, (message) => ({
      ...message,
      recipeCaptureStatus: 'capturing',
      recipeCaptureError: undefined,
    }));
    try {
      const captured = await captureRecipeDraft<RecipeCaptureResponse>(sourceRunId);
      const saved = await saveCustomRecipe<RecipeSaveResponse>(captured.recipe);
      onRecipeSaved?.({ id: saved.recipe.id, name: saved.recipe.name, summary: saved.recipe.description || saved.recipe.prompt });
      patchAssistant(assistantId, (message) => ({
        ...message,
        recipeDraft: { ...captured.recipe, ...saved.recipe },
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
  }, [onRecipeSaved, patchAssistant]);
}
