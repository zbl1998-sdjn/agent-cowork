// 主区面板容器(UI · 组件层 · components)
// ---------------------------------------------------------------------------
// 对标 Claude:面板不再是右侧抽屉,而是切换到主区显示(替代对话/首页),顶部给「返回对话」。
// 按当前选中标签 lazy 加载并挂载对应面板(任务/工具/可视化/连接器/产物/项目/定时/记忆/可观测),ErrorBoundary 隔离。
import { lazy, Suspense } from 'react';
import type { SubagentStep } from '../lib/api';
import type { SidePanel } from '../lib/app-types';
import type { WorkbenchPreviewState } from './composer-types';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { Loading } from './ui/StateViews';

const ToolsPanel = lazy(() => import('./panels/ToolsPanel').then((module) => ({ default: module.ToolsPanel })));
const VizPanel = lazy(() => import('./panels/VizPanel').then((module) => ({ default: module.VizPanel })));
const ConnectorsPanel = lazy(() => import('./panels/ConnectorsPanel').then((module) => ({ default: module.ConnectorsPanel })));
const ArtifactsPanel = lazy(() => import('./panels/ArtifactsPanel').then((module) => ({ default: module.ArtifactsPanel })));
const ProjectsPanel = lazy(() => import('./panels/ProjectsPanel').then((module) => ({ default: module.ProjectsPanel })));
const SchedulesPanel = lazy(() => import('./panels/SchedulesPanel').then((module) => ({ default: module.SchedulesPanel })));
const MemoryPanel = lazy(() => import('./panels/MemoryPanel').then((module) => ({ default: module.MemoryPanel })));
const ObservabilityPanel = lazy(() => import('./panels/ObservabilityPanel').then((module) => ({ default: module.ObservabilityPanel })));
const TasksPanel = lazy(() => import('./panels/TasksPanel').then((module) => ({ default: module.TasksPanel })));

interface AppSidePanelProps {
  panel: SidePanel;
  trustedRoot: string;
  workbenchPreview?: WorkbenchPreviewState | undefined;
  onClose: () => void;
  onRunSubagent: (goal: string, steps: SubagentStep[]) => void;
}

const PANEL_LABELS: Record<Exclude<SidePanel, 'none'>, string> = {
  tasks: '任务中心',
  tools: '工具',
  viz: '可视化',
  connectors: '连接器',
  artifacts: '产物',
  projects: '项目',
  schedules: '定时任务',
  memory: '记忆',
  observability: '成本 · 可观测',
};

function panelContent(
  panel: Exclude<SidePanel, 'none'>,
  trustedRoot: string,
  onRunSubagent: AppSidePanelProps['onRunSubagent'],
  workbenchPreview?: WorkbenchPreviewState,
) {
  if (panel === 'tasks') return <TasksPanel />;
  if (panel === 'tools') return <ToolsPanel trustedRoot={trustedRoot} onRunPlan={onRunSubagent} />;
  if (panel === 'viz') return <VizPanel trustedRoot={trustedRoot} workbenchPreview={workbenchPreview} />;
  if (panel === 'connectors') return <ConnectorsPanel trustedRoot={trustedRoot} />;
  if (panel === 'artifacts') return <ArtifactsPanel trustedRoot={trustedRoot} />;
  if (panel === 'projects') return <ProjectsPanel trustedRoot={trustedRoot} />;
  if (panel === 'schedules') return <SchedulesPanel trustedRoot={trustedRoot} />;
  if (panel === 'memory') return <MemoryPanel trustedRoot={trustedRoot} />;
  return <ObservabilityPanel />;
}

export function AppSidePanel({ panel, trustedRoot, workbenchPreview, onClose, onRunSubagent }: AppSidePanelProps) {
  if (panel === 'none') return null;
  return (
    <div className="main-panel">
      <div className="main-panel-head">
        <button type="button" className="main-panel-back" onClick={onClose}>← 返回对话</button>
        <span className="main-panel-title">{PANEL_LABELS[panel]}</span>
      </div>
      <ErrorBoundary key={panel} label={PANEL_LABELS[panel]}>
        <Suspense fallback={<Loading message="正在加载…" />}>
          <div className="main-panel-body">
            {panelContent(panel, trustedRoot, onRunSubagent, workbenchPreview)}
          </div>
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
