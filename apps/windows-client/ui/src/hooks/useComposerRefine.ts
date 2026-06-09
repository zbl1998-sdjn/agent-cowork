// useComposerRefine(UI · hooks 层)
// ---------------------------------------------------------------------------
// 职责:输入框「提示词精炼」交互态——发起精炼、展示候选/对比、采纳或撤销,管理加载/错误。依赖:lib/api/prompt。
import { useCallback, useRef, useState } from 'react';
import type { PromptRefineResult } from '../lib/api/prompt';
import { resolveRefineSendDecision, shouldRefineBeforeSend } from '../lib/composer-logic';

type SendDecision = { action: 'send'; text: string } | { action: 'preview' };

export function useComposerRefine({
  autoClarify,
  onRefinePrompt,
  onPreviewResolved,
}: {
  autoClarify: boolean;
  onRefinePrompt?: ((text: string) => Promise<PromptRefineResult>) | undefined;
  onPreviewResolved: (prompt: string) => void;
}) {
  const [refining, setRefining] = useState(false);
  const [refineOriginal, setRefineOriginal] = useState('');
  const [refineResult, setRefineResult] = useState<PromptRefineResult | null>(null);
  const [refineNotice, setRefineNotice] = useState('');
  const skipRefineFor = useRef('');

  const clearRefine = useCallback(() => {
    setRefineOriginal('');
    setRefineResult(null);
  }, []);

  const fetchRefine = useCallback(async (text: string, showError: boolean): Promise<PromptRefineResult | null> => {
    if (!onRefinePrompt) return null;
    setRefining(true);
    if (showError) setRefineNotice('');
    try {
      return await onRefinePrompt(text);
    } catch {
      if (showError) setRefineNotice('提示优化暂不可用，请稍后重试');
      return null;
    } finally {
      setRefining(false);
    }
  }, [onRefinePrompt]);

  const refineCurrent = useCallback(async (value: string) => {
    const text = value.trim();
    if (!onRefinePrompt) return;
    if (!text) {
      // 优化按钮始终可点,空输入时给出可见反馈,避免用户以为按钮失效。
      setRefineNotice('请先在输入框写一句要优化的提示,再点优化。');
      return;
    }
    const result = await fetchRefine(text, true);
    if (!result) return;
    if (result.changed || result.needsClarification) {
      setRefineOriginal(text);
      setRefineResult(result);
      setRefineNotice('');
      return;
    }
    clearRefine();
    setRefineNotice('当前提示已足够明确');
  }, [clearRefine, fetchRefine, onRefinePrompt]);

  const resolvePreview = useCallback((prompt: string) => {
    const next = prompt.trim();
    skipRefineFor.current = next;
    clearRefine();
    setRefineNotice('');
    onPreviewResolved(next);
  }, [clearRefine, onPreviewResolved]);

  const prepareSend = useCallback(async (text: string): Promise<SendDecision> => {
    let finalText = text;
    if (shouldRefineBeforeSend(autoClarify, text) && skipRefineFor.current !== text) {
      const result = await fetchRefine(text, false);
      if (result) {
        const decision = resolveRefineSendDecision(text, result);
        if (decision.action === 'preview') {
          setRefineOriginal(text);
          setRefineResult(decision.result);
          setRefineNotice('');
          return { action: 'preview' };
        }
        finalText = decision.text;
      }
    }
    return { action: 'send', text: finalText };
  }, [autoClarify, fetchRefine]);

  const markChanged = useCallback((next: string) => {
    if (next.trim() !== skipRefineFor.current) skipRefineFor.current = '';
    if (refineResult) clearRefine();
    if (refineNotice) setRefineNotice('');
  }, [clearRefine, refineNotice, refineResult]);

  const resetRefineAfterSend = useCallback(() => {
    skipRefineFor.current = '';
    clearRefine();
    setRefineNotice('');
  }, [clearRefine]);

  return {
    refining,
    refineOriginal,
    refineResult,
    refineNotice,
    canRefine: Boolean(onRefinePrompt),
    markChanged,
    prepareSend,
    refineCurrent,
    resetRefineAfterSend,
    resolvePreview,
  };
}
