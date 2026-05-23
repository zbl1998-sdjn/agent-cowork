import type { ArtifactFile } from '../lib/types';

export interface ArtifactCardProps {
  file: ArtifactFile;
  metadata?: string;
  onOpen: (path: string) => void;
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

export function ArtifactCard({ file, metadata, onOpen }: ArtifactCardProps) {
  return (
    <div className="artifact-card">
      <div className="artifact-icon" aria-hidden="true">▤</div>
      <div className="artifact-body">
        <strong>{basename(file.relativePath || file.path)}</strong>
        <span>{metadata || file.relativePath || file.path}</span>
      </div>
      <button type="button" onClick={() => onOpen(file.path)}>在系统中打开</button>
    </div>
  );
}
