// 定时任务面板状态(UI · hooks):集中加载、表单、幂等创建、取消及错误恢复；组件只负责渲染。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildScheduleCreateRequest,
  cancelSchedule,
  createSchedule,
  getWorkspaceGrantId,
  getRunRecord,
  listEnabledScheduleSkills,
  listSchedules,
  resolveScheduleCreateAttempt,
} from '../lib/api';
import { humanizeError } from '../lib/friendly-error';
import type { RunRecord } from '../lib/types';
import type {
  ScheduleCreateAttempt,
  ScheduleItem,
  ScheduleSkill,
  ScheduleTriggerKind,
} from '../lib/types/schedules';

export function useSchedulesPanel(trustedRoot: string) {
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [skills, setSkills] = useState<ScheduleSkill[]>([]);
  const [loadError, setLoadError] = useState('');
  const [mutationError, setMutationError] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [recipeId, setRecipeId] = useState('');
  const [kind, setKind] = useState<ScheduleTriggerKind>('cron');
  const [cron, setCron] = useState('0 9 * * 1');
  const [fireAt, setFireAt] = useState('');
  const [prompt, setPrompt] = useState('');
  const [reviewRunId, setReviewRunId] = useState('');
  const [reviewRun, setReviewRun] = useState<RunRecord | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const createAttemptRef = useRef<ScheduleCreateAttempt | null>(null);
  const reviewRequestRef = useRef(0);

  const refresh = useCallback(async () => {
    setBusy(true);
    setLoadError('');
    try {
      const [nextItems, nextSkills] = await Promise.all([listSchedules(), listEnabledScheduleSkills()]);
      setItems(nextItems);
      setSkills(nextSkills);
      setRecipeId((current) => nextSkills.some((skill) => skill.id === current) ? current : (nextSkills[0]?.id || ''));
    } catch (error) {
      setLoadError(humanizeError(error, { action: '读取定时任务' }));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = async () => {
    setCreating(true);
    setMutationError('');
    try {
      const folderGrantId = getWorkspaceGrantId();
      const request = buildScheduleCreateRequest({
        name,
        recipeId,
        kind,
        cron,
        fireAt,
        prompt,
        trustedRoot,
        ...(folderGrantId ? { folderGrantId } : {}),
      });
      const attempt = resolveScheduleCreateAttempt(request, createAttemptRef.current);
      createAttemptRef.current = attempt;
      await createSchedule(attempt.request, attempt.idempotencyKey);
      createAttemptRef.current = null;
      setName('');
      setPrompt('');
      await refresh();
    } catch (error) {
      setMutationError(humanizeError(error, { action: '创建定时任务' }));
    } finally {
      setCreating(false);
    }
  };

  const cancel = async (id: string) => {
    setMutationError('');
    try {
      await cancelSchedule(id);
      await refresh();
    } catch (error) {
      setMutationError(humanizeError(error, { action: '取消定时任务' }));
    }
  };

  const reviewScheduledRun = useCallback(async (runId: string) => {
    const normalizedRunId = String(runId || '').trim();
    if (!normalizedRunId) return;
    const requestId = reviewRequestRef.current + 1;
    reviewRequestRef.current = requestId;
    setReviewRunId(normalizedRunId);
    setReviewRun(null);
    setReviewError('');
    setReviewBusy(true);
    try {
      const record = await getRunRecord(normalizedRunId);
      if (reviewRequestRef.current === requestId) setReviewRun(record);
    } catch (error) {
      if (reviewRequestRef.current === requestId) {
        setReviewError(humanizeError(error, { action: '复核定时运行' }));
      }
    } finally {
      if (reviewRequestRef.current === requestId) setReviewBusy(false);
    }
  }, []);

  const closeRunReview = useCallback(() => {
    reviewRequestRef.current += 1;
    setReviewRunId('');
    setReviewRun(null);
    setReviewError('');
    setReviewBusy(false);
  }, []);

  return {
    items,
    skills,
    loadError,
    mutationError,
    busy,
    creating,
    name,
    recipeId,
    kind,
    cron,
    fireAt,
    prompt,
    reviewRunId,
    reviewRun,
    reviewBusy,
    reviewError,
    setName,
    setRecipeId,
    setKind,
    setCron,
    setFireAt,
    setPrompt,
    refresh,
    create,
    cancel,
    reviewScheduledRun,
    closeRunReview,
  };
}
