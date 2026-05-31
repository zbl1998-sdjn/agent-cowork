// ArtifactCard(UI · components):时间线里的制品卡片——展示一个生成制品(名称/类型/预览)并提供打开/下载。纯展示+回调。
import type { ArtifactFile } from '../lib/types';
import { Button } from './ui/Button';

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
      <Button onClick={() => onOpen(file.path)}>在系统中打开</Button>
    </div>
  );
}
