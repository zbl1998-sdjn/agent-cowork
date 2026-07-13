import { useState, type ReactNode } from 'react';
import { Icon } from './ui/Icon';
import { ArtifactCanvas } from './ArtifactCanvas';

interface ConversationWorkspaceProps {
  children: ReactNode;
  artifactId: string | null;
  artifactText: string;
  streaming: boolean;
  onApplyArtifact: (text: string) => void;
  onRequestRevision: (prompt: string) => void;
}

export function ConversationWorkspace({ children, artifactId, artifactText, streaming, onApplyArtifact, onRequestRevision }: ConversationWorkspaceProps) {
  const [canvasCollapsed, setCanvasCollapsed] = useState(false);
  return (
    <main className={`conversation-workspace${canvasCollapsed ? ' is-canvas-collapsed' : ''}`}>
      <div className="conversation-pane">{children}</div>
      {canvasCollapsed ? (
        <button className="artifact-canvas-restore" type="button" aria-label="展开成果画布" onClick={() => setCanvasCollapsed(false)}>
          <Icon name="artifacts" size={17} /><span>展开成果画布</span>
        </button>
      ) : (
        <ArtifactCanvas artifactId={artifactId} text={artifactText} streaming={streaming} onApplyText={onApplyArtifact} onRequestRevision={onRequestRevision} onCollapse={() => setCanvasCollapsed(true)} />
      )}
    </main>
  );
}
