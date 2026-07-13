// 可视化编辑入口(UI · 组件层 · components/panels)
// ---------------------------------------------------------------------------
// 职责:把主导航中的“可视化”直接落到 Office/Web 高级编辑能力，不再暴露 JSON 活页构建器。
import type { WorkbenchPreviewState } from '../../lib/types/composer';
import { ArtifactsPanel } from './ArtifactsPanel';

interface VizPanelProps {
  trustedRoot: string;
  workbenchPreview?: WorkbenchPreviewState | undefined;
}

export function VizPanel({ trustedRoot }: VizPanelProps) {
  return <ArtifactsPanel trustedRoot={trustedRoot} variant="visual" />;
}
