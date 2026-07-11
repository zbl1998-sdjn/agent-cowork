// 定时任务面板(UI · components/panels):只渲染任务、历史、只读复核与取消确认。
import type { FormEvent } from 'react';
import { useSchedulesPanel } from '../../hooks/useSchedulesPanel';
import { humanizeScheduleLine, humanizeScheduleStatus } from '../../lib/schedule-humanize';
import type { FileOperation, RunRecord } from '../../lib/types';
import type { ScheduleItem, ScheduleTriggerKind } from '../../lib/types/schedules';
import { PreviewCard } from '../PreviewCard';
import { Button } from '../ui/Button';
import { Empty, ErrorState } from '../ui/StateViews';

export function SchedulesPanelStateViews({ error, onRetry }: { error: string; onRetry: () => void }) {
  if (error) {
    return <ErrorState title="定时任务加载失败" message={error} onRetry={onRetry} retryLabel="重新加载" />;
  }
  return (
    <Empty
      title="还没有定时任务"
      message="可以选择已启用的技能并设置周期或一次性触发时间。"
    />
  );
}

export function ScheduleMutationError({ error }: { error: string }) {
  if (!error) return null;
  return (
    <div className="panel-error" role="alert">
      <strong>定时任务操作失败</strong>
      <p>{error}</p>
      <small>当前输入和待处理任务仍保留，可直接重试原操作。</small>
    </div>
  );
}

function runStatusLabel(status: string | undefined): string {
  if (status === 'awaiting_approval') return '等待审批';
  if (status === 'done' || status === 'completed') return '已完成';
  if (status === 'failed') return '失败';
  if (status === 'cancelled') return '已取消';
  if (status === 'pending' || status === 'planning') return '处理中';
  return status || '未知状态';
}

function runResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
  const text = (result as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

function normalisePreviewOperation(value: unknown): FileOperation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const type = typeof candidate.type === 'string'
    ? candidate.type
    : (typeof candidate.kind === 'string' ? candidate.kind : '');
  if (!type) return null;
  const operation: FileOperation = { type };
  for (const key of ['path', 'targetPath', 'from', 'to', 'newName'] as const) {
    if (typeof candidate[key] === 'string') operation[key] = candidate[key];
  }
  return operation;
}

function latestPreviewOperations(run: RunRecord | null): FileOperation[] {
  if (!Array.isArray(run?.events)) return [];
  for (let index = run.events.length - 1; index >= 0; index -= 1) {
    const event = run.events[index];
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    const candidate = event as { type?: unknown; operations?: unknown };
    if (candidate.type !== 'preview' || !Array.isArray(candidate.operations)) continue;
    return candidate.operations
      .map(normalisePreviewOperation)
      .filter((operation): operation is FileOperation => operation !== null);
  }
  return [];
}

export function ScheduleRunReview({
  runId,
  busy,
  error,
  run,
  onClose,
}: {
  runId: string;
  busy: boolean;
  error: string;
  run: RunRecord | null;
  onClose: () => void;
}) {
  if (!runId) return null;
  const operations = latestPreviewOperations(run);
  const resultText = runResultText(run?.result);
  return (
    <section className="schedule-run-review" aria-label="运行结果（只读）">
      <header className="panel-row">
        <div>
          <h3>运行结果（只读）</h3>
          <p><code>{runId}</code>{run ? ` · ${runStatusLabel(run.status)}` : ''}</p>
        </div>
        <Button onClick={onClose}>关闭</Button>
      </header>
      {busy && <p role="status">正在读取已保存的运行记录…</p>}
      {error && <p className="panel-error" role="alert">{error}</p>}
      {resultText && <p>{resultText}</p>}
      {operations.length > 0 && (
        <PreviewCard operations={operations} summary="历史预览，仅供复核" />
      )}
    </section>
  );
}

// 每个定时任务一行;名称、状态徽标和时间线都走 humanize-* 辅助函数,
// 让非技术用户看到"每天 09:00 · 下次 今天 09:00 · 运行中",而不是原始 cron/ISO 时间。
export function SchedulePanelItem({
  item,
  onCancel,
  onReviewRun,
}: {
  item: ScheduleItem;
  onCancel: (id: string) => void;
  onReviewRun?: (runId: string) => void;
}) {
  const when = humanizeScheduleLine(item);
  const status = humanizeScheduleStatus(item.status);
  const recipeId = String(item.recipeId || item.payload?.recipeId || '').trim();
  const attempts = Array.isArray(item.attempts) ? item.attempts : [];
  const askCancel = () => {
    // 轻量二次确认:避免误点把用户依赖的长期任务直接删掉。
    const friendlyName = item.name || '这个任务';
    if (window.confirm(`确定要停用「${friendlyName}」吗?之后想再开,需要重新创建。`)) {
      onCancel(item.id);
    }
  };
  return (
    <li>
      <strong className="schedule-name">{item.name || '未命名任务'}</strong>
      <span className="tool-src">{status}</span>
      {when && <p className="schedule-when">{when}</p>}
      {recipeId && <p className="schedule-when">技能：<code>{recipeId}</code></p>}
      {item.lastError && <p className="panel-error" role="alert">最近失败（上次生成失败）：{item.lastError}</p>}
      {item.lastRunId && <p className="schedule-when">最近成功运行：<code>{item.lastRunId}</code></p>}
      {attempts.length > 0 && (
        <details className="schedule-history">
          <summary>运行历史（{attempts.length}）</summary>
          <ol>
            {[...attempts].reverse().map((attempt) => (
              <li key={attempt.attemptId}>
                <strong>{attempt.status === 'succeeded' ? '已生成草案' : '执行失败'}</strong>
                <span> · {attempt.finishedAt}</span>
                {attempt.error && <p className="panel-error">{attempt.error}</p>}
                {attempt.runId && onReviewRun && (
                  <Button onClick={() => onReviewRun(attempt.runId as string)}>只读复核</Button>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
      {item.status !== 'cancelled' && (
        <Button onClick={askCancel}>取消</Button>
      )}
    </li>
  );
}

// 列出 Agent 或用户经 host 调度器创建的定时任务,并提供一键取消入口。
export function SchedulesPanel({ trustedRoot = '' }: { trustedRoot?: string }) {
  const state = useSchedulesPanel(trustedRoot);
  const onCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void state.create();
  };

  return (
    <section className="side-panel">
      <h2>定时任务</h2>
      <p className="panel-intro">把一个已启用技能绑定到周期或一次性触发时间；到点生成待审批草案，确认前不会写入工作区。</p>
      <form className="schedule-create-form" onSubmit={onCreate}>
        <h3>新建定时任务</h3>
        <div className="schedule-form-grid">
          <label>
            <span>任务名称</span>
            <input value={state.name} onChange={(event) => state.setName(event.target.value)} placeholder="如：每周会议纪要" required />
          </label>
          <label>
            <span>执行技能</span>
            <select value={state.recipeId} onChange={(event) => state.setRecipeId(event.target.value)} required disabled={!state.skills.length}>
              {!state.skills.length && <option value="">暂无已启用技能</option>}
              {state.skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}
            </select>
          </label>
          <label>
            <span>触发方式</span>
            <select value={state.kind} onChange={(event) => state.setKind(event.target.value as ScheduleTriggerKind)}>
              <option value="cron">周期</option>
              <option value="once">一次性</option>
            </select>
          </label>
          {state.kind === 'cron' ? (
            <label>
              <span>Cron（分 时 日 月 周）</span>
              <input value={state.cron} onChange={(event) => state.setCron(event.target.value)} placeholder="0 9 * * 1" required />
            </label>
          ) : (
            <label>
              <span>触发时间</span>
              <input type="datetime-local" value={state.fireAt} onChange={(event) => state.setFireAt(event.target.value)} required />
            </label>
          )}
          <label className="schedule-form-wide">
            <span>本次输入（可选）</span>
            <textarea value={state.prompt} onChange={(event) => state.setPrompt(event.target.value)} rows={3} placeholder="补充本次技能运行需要的上下文" />
          </label>
        </div>
        <Button type="submit" variant="primary" disabled={state.creating || !state.skills.length}>
          {state.creating ? '创建中…' : '创建任务'}
        </Button>
      </form>
      <div className="panel-row">
        <Button disabled={state.busy} onClick={() => void state.refresh()}>{state.busy ? '刷新中…' : '刷新'}</Button>
      </div>
      <ul className="tool-list">
        {state.items.map((s) => (
          <SchedulePanelItem
            key={s.id}
            item={s}
            onCancel={(id) => void state.cancel(id)}
            onReviewRun={(runId) => void state.reviewScheduledRun(runId)}
          />
        ))}
        {state.items.length === 0 && !state.loadError && (
          <li className="panel-empty">
            <SchedulesPanelStateViews error="" onRetry={() => void state.refresh()} />
          </li>
        )}
      </ul>
      {state.loadError && <SchedulesPanelStateViews error={state.loadError} onRetry={() => void state.refresh()} />}
      <ScheduleMutationError error={state.mutationError} />
      <ScheduleRunReview
        runId={state.reviewRunId}
        busy={state.reviewBusy}
        error={state.reviewError}
        run={state.reviewRun}
        onClose={state.closeRunReview}
      />
    </section>
  );
}
