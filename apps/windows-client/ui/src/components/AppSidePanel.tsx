import { lazy, Suspense } from 'react';
import type { SubagentStep } from '../lib/api';
import type { SidePanel } from '../lib/app-types';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { Loading } from './ui/StateViews';

const ToolsPanel = lazy(() => import('./ToolsPanel').then((module) => ({ default: module.ToolsPanel })));
const VizPanel = lazy(() => import('./VizPanel').then((module) => ({ default: module.VizPanel })));
const ConnectorsPanel = lazy(() => import('./ConnectorsPanel').then((module) => ({ default: module.ConnectorsPanel })));
const ArtifactsPanel = lazy(() => import('./ArtifactsPanel').then((module) => ({ default: module.ArtifactsPanel })));
const SchedulesPanel = lazy(() => import('./panels/SchedulesPanel').then((module) => ({ default: module.SchedulesPanel })));
const MemoryPanel = lazy(() => import('./MemoryPanel').then((module) => ({ default: module.MemoryPanel })));
const ObservabilityPanel = lazy(() => import('./ObservabilityPanel').then((module) => ({ default: module.ObservabilityPanel })));

interface AppSidePanelProps {
  panel: SidePanel;
  trustedRoot: string;
  onClose: () => void;
  onRunSubagent: (goal: string, steps: SubagentStep[]) => void;
}

const PANEL_LABELS: Record<Exclude<SidePanel, 'none'>, string> = {
  tools: '工具面板',
  viz: '可视化面板',
  connectors: '连接器面板',
  artifacts: '产物面板',
  schedules: '定时任务面板',
  memory: '记忆面板',
  observability: '可观测面板',
};

function panelContent(panel: Exclude<SidePanel, 'none'>, trustedRoot: string, onRunSubagent: AppSidePanelProps['onRunSubagent']) {
  if (panel === 'tools') return <ToolsPanel trustedRoot={trustedRoot} onRunPlan={onRunSubagent} />;
  if (panel === 'viz') return <VizPanel trustedRoot={trustedRoot} />;
  if (panel === 'connectors') return <ConnectorsPanel trustedRoot={trustedRoot} />;
  if (panel === 'artifacts') return <ArtifactsPanel trustedRoot={trustedRoot} />;
  if (panel === 'schedules') return <SchedulesPanel />;
  if (panel === 'memory') return <MemoryPanel trustedRoot={trustedRoot} />;
  return <ObservabilityPanel />;
}

export function AppSidePanel({ panel, trustedRoot, onClose, onRunSubagent }: AppSidePanelProps) {
  if (panel === 'none') return null;
  return (
    <aside className="side-drawer">
      <button type="button" className="drawer-close" aria-label="关闭" onClick={onClose}>×</button>
      <ErrorBoundary key={panel} label={PANEL_LABELS[panel]}>
        <Suspense fallback={<Loading message="正在加载面板…" />}>
          {panelContent(panel, trustedRoot, onRunSubagent)}
        </Suspense>
      </ErrorBoundary>
    </aside>
  );
}
