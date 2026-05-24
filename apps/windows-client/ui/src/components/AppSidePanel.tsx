import type { SubagentStep } from '../lib/api';
import type { SidePanel } from '../lib/app-types';
import { ArtifactsPanel } from './ArtifactsPanel';
import { ConnectorsPanel } from './ConnectorsPanel';
import { MemoryPanel } from './MemoryPanel';
import { SchedulesPanel } from './SchedulesPanel';
import { ToolsPanel } from './ToolsPanel';
import { VizPanel } from './VizPanel';

interface AppSidePanelProps {
  panel: SidePanel;
  trustedRoot: string;
  onClose: () => void;
  onRunSubagent: (goal: string, steps: SubagentStep[]) => void;
}

export function AppSidePanel({ panel, trustedRoot, onClose, onRunSubagent }: AppSidePanelProps) {
  if (panel === 'none') return null;
  return (
    <aside className="side-drawer">
      <button type="button" className="drawer-close" aria-label="关闭" onClick={onClose}>×</button>
      {panel === 'tools' && <ToolsPanel trustedRoot={trustedRoot} onRunPlan={onRunSubagent} />}
      {panel === 'viz' && <VizPanel trustedRoot={trustedRoot} />}
      {panel === 'connectors' && <ConnectorsPanel trustedRoot={trustedRoot} />}
      {panel === 'artifacts' && <ArtifactsPanel trustedRoot={trustedRoot} />}
      {panel === 'schedules' && <SchedulesPanel />}
      {panel === 'memory' && <MemoryPanel trustedRoot={trustedRoot} />}
    </aside>
  );
}
