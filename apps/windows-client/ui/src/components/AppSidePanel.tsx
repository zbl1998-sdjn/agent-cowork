// 右侧侧边面板容器(UI · 组件层 · components)
// ---------------------------------------------------------------------------
// 职责:按当前选中标签 lazy 加载并挂载对应面板(工具/可视化/连接器/产物/项目/定时任务/记忆/可观测),用 ErrorBoundary 隔离。
// 依赖:panels/* 各懒加载面板、ErrorBoundary、Loading、IconButton。关键回调:onClose / onRunSubagent。
import { lazy, Suspense } from 'react';
import type { SubagentStep } from '../lib/api';
import type { SidePanel } from '../lib/app-types';
import type { WorkbenchPreviewState } from './composer-types';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { IconButton } from './ui/Button';
import { Loading } from './ui/StateViews';

const ToolsPanel = lazy(() => import('./panels/ToolsPanel').then((module) => ({ default: module.ToolsPanel })));
const VizPanel = lazy(() => import('./panels/VizPanel').then((module) => ({ default: module.VizPanel })));
const ConnectorsPanel = lazy(() => import('./panels/ConnectorsPanel').then((module) => ({ default: module.ConnectorsPanel })));
const ArtifactsPanel = lazy(() => import('./panels/ArtifactsPanel').then((module) => ({ default: module.ArtifactsPanel })));
const ProjectsPanel = lazy(() => import('./panels/ProjectsPanel').then((module) => ({ default: module.ProjectsPanel })));
const SchedulesPanel = lazy(() => import('./panels/SchedulesPanel').then((module) => ({ default: module.SchedulesPanel })));
const MemoryPanel = lazy(() => import('./panels/MemoryPanel').then((module) => ({ default: module.MemoryPanel })));
const ObservabilityPanel = lazy(() => import('./panels/ObservabilityPanel').then((module) => ({ default: module.ObservabilityPanel })));

interface AppSidePanelProps {
  panel: SidePanel;
  trustedRoot: string;
  workbenchPreview?: WorkbenchPreviewState | undefined;
  onClose: () => void;
  onRunSubagent: (goal: string, steps: SubagentStep[]) => void;
}

const PANEL_LABELS: Record<Exclude<SidePanel, 'none'>, string> = {
  tools: '工具面板',
  viz: '可视化面板',
  connectors: '连接器面板',
  artifacts: '产物面板',
  projects: '项目面板',
  schedules: '定时任务面板',
  memory: '记忆面板',
  observability: '可观测面板',
};

function panelContent(
  panel: Exclude<SidePanel, 'none'>,
  trustedRoot: string,
  onRunSubagent: AppSidePanelProps['onRunSubagent'],
  workbenchPreview?: WorkbenchPreviewState,
) {
  if (panel === 'tools') return <ToolsPanel trustedRoot={trustedRoot} onRunPlan={onRunSubagent} />;
  if (panel === 'viz') return <VizPanel trustedRoot={trustedRoot} workbenchPreview={workbenchPreview} />;
  if (panel === 'connectors') return <ConnectorsPanel trustedRoot={trustedRoot} />;
  if (panel === 'artifacts') return <ArtifactsPanel trustedRoot={trustedRoot} />;
  if (panel === 'projects') return <ProjectsPanel trustedRoot={trustedRoot} />;
  if (panel === 'schedules') return <SchedulesPanel />;
  if (panel === 'memory') return <MemoryPanel trustedRoot={trustedRoot} />;
  return <ObservabilityPanel />;
}

export function AppSidePanel({ panel, trustedRoot, workbenchPreview, onClose, onRunSubagent }: AppSidePanelProps) {
  if (panel === 'none') return null;
  return (
    <aside className="side-drawer">
      <div className="drawer-header">
        <span>{PANEL_LABELS[panel]}</span>
        <IconButton className="drawer-close" label="关闭" onClick={onClose}>×</IconButton>
      </div>
      <ErrorBoundary key={panel} label={PANEL_LABELS[panel]}>
        <Suspense fallback={<Loading message="正在加载面板…" />}>
          {panelContent(panel, trustedRoot, onRunSubagent, workbenchPreview)}
        </Suspense>
      </ErrorBoundary>
    </aside>
  );
}
