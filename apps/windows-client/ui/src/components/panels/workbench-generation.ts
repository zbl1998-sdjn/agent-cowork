import type { WorkbenchPreviewState } from '../composer-types';

export interface WorkbenchGenerationModel {
  phase: string;
  active: boolean;
  latestActivity: string;
  updateCount: number;
}

export function buildWorkbenchGenerationModel(preview: WorkbenchPreviewState): WorkbenchGenerationModel | undefined {
  const generation = preview.generation;
  if (!generation) return undefined;
  const phase = generation.status === 'failed'
    ? '失败'
    : generation.status === 'done'
      ? '完成'
      : generation.tools.some((tool) => tool.status === 'running')
        ? '执行'
        : generation.status === 'thinking' ? '分析' : '生成';
  return {
    phase,
    active: preview.streaming,
    latestActivity: generation.progress.at(-1)?.text || generation.tools.at(-1)?.name || '等待首个生成片段',
    updateCount: generation.progress.length + (generation.text ? 1 : 0),
  };
}
