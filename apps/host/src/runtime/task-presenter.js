export function taskFromRun(run) {
  const status = run.status === 'succeeded' ? 'done' : run.status === 'failed' ? 'failed' : 'in_progress';
  return {
    id: run.id,
    status,
    activeForm: status === 'in_progress' ? '任务运行中' : status === 'failed' ? '需要查看错误' : '已完成',
    prompt: run.prompt,
    mode: run.mode,
    type: run.type,
    provider: run.provider,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    summary: run.summary,
  };
}
