import type { ReactNode } from 'react';
import { Icon } from './ui/Icon';
import { ArtifactCanvas } from './ArtifactCanvas';

interface ConversationWorkspaceProps {
  children: ReactNode;
  artifactId: string | null;
  artifactText: string;
  streaming: boolean;
  canvasCollapsed: boolean;
  onApplyArtifact: (text: string) => void;
  onRequestRevision: (prompt: string) => void;
  onSetCanvasCollapsed: (collapsed: boolean) => void;
}

export function ConversationWorkspace({ children, artifactId, artifactText, streaming, canvasCollapsed, onApplyArtifact, onRequestRevision, onSetCanvasCollapsed }: ConversationWorkspaceProps) {
  return (
    <main className={`conversation-workspace${canvasCollapsed ? ' is-canvas-collapsed' : ''}`}>
      <div className="conversation-pane">{children}</div>
      {canvasCollapsed ? (
        <button className="artifact-canvas-restore" type="button" aria-label="展开成果画布" onClick={() => onSetCanvasCollapsed(false)}>
          <Icon name="artifacts" size={17} /><span>展开成果画布</span>
        </button>
      ) : (
        <ArtifactCanvas artifactId={artifactId} text={artifactText} streaming={streaming} onApplyText={onApplyArtifact} onRequestRevision={onRequestRevision} onCollapse={() => onSetCanvasCollapsed(true)} />
      )}
    </main>
  );
}
