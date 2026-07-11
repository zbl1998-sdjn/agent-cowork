// 任务中心状态(UI · hooks):集中加载、搜索和状态筛选；组件只负责展示与触发刷新。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getRunRecord, listTasks } from '../lib/api';
import { humanizeError } from '../lib/friendly-error';
import type { RunRecord } from '../lib/types';
import type { TaskSummary } from '../lib/types/tasks';

export type TaskFilter = 'all' | 'attention' | 'in_progress' | 'done';

export type TaskDetailRequestCallbacks = {
  onStart(runId: string): void;
  onSuccess(record: RunRecord): void;
  onError(error: unknown): void;
  onSettled(runId: string): void;
};

export function createTaskDetailRequestCoordinator(
  loadRecord: (runId: string) => Promise<RunRecord>,
) {
  let generation = 0;
  return {
    async load(runId: string, callbacks: TaskDetailRequestCallbacks): Promise<void> {
      const requestGeneration = ++generation;
      callbacks.onStart(runId);
      try {
        const record = await loadRecord(runId);
        if (requestGeneration === generation) callbacks.onSuccess(record);
      } catch (error) {
        if (requestGeneration === generation) callbacks.onError(error);
      } finally {
        if (requestGeneration === generation) callbacks.onSettled(runId);
      }
    },
    invalidate(): void {
      generation += 1;
    },
  };
}

function matchesFilter(task: TaskSummary, filter: TaskFilter): boolean {
  if (filter === 'attention') return task.status === 'awaiting_approval' || task.status === 'failed';
  if (filter === 'in_progress') return task.status === 'in_progress';
  if (filter === 'done') return task.status === 'done';
  return true;
}

function matchesQuery(task: TaskSummary, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [task.id, task.prompt, task.summary, task.error, task.type, task.provider, task.mode]
    .some((value) => String(value || '').toLocaleLowerCase().includes(needle));
}

export function useTasksPanel() {
  const [items, setItems] = useState<TaskSummary[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<RunRecord | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState('');
  const detailCoordinator = useRef<ReturnType<typeof createTaskDetailRequestCoordinator> | null>(null);
  if (!detailCoordinator.current) {
    detailCoordinator.current = createTaskDetailRequestCoordinator(getRunRecord);
  }

  const refresh = useCallback(async () => {
    setBusy(true);
    setLoadError('');
    try {
      setItems(await listTasks(100));
    } catch (error) {
      setLoadError(humanizeError(error, { action: '读取任务' }));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => () => detailCoordinator.current?.invalidate(), []);

  const selectTask = useCallback((runId: string) => {
    void detailCoordinator.current?.load(runId, {
      onStart: (nextId) => {
        setSelectedId(nextId);
        setSelected(null);
        setDetailError('');
        setDetailBusy(true);
      },
      onSuccess: setSelected,
      onError: (error) => {
        setSelected(null);
        setDetailError(humanizeError(error, { action: '读取任务详情' }));
      },
      onSettled: () => setDetailBusy(false),
    });
  }, []);

  const closeTaskDetail = useCallback(() => {
    detailCoordinator.current?.invalidate();
    setSelectedId(null);
    setSelected(null);
    setDetailBusy(false);
    setDetailError('');
  }, []);

  const visibleItems = useMemo(
    () => items.filter((item) => matchesFilter(item, filter) && matchesQuery(item, query)),
    [filter, items, query],
  );
  const attentionCount = useMemo(
    () => items.filter((item) => matchesFilter(item, 'attention')).length,
    [items],
  );

  return {
    items,
    visibleItems,
    attentionCount,
    query,
    filter,
    busy,
    loadError,
    selectedId,
    selected,
    detailBusy,
    detailError,
    setQuery,
    setFilter,
    refresh,
    selectTask,
    closeTaskDetail,
  };
}
