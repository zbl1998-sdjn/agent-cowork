// Read-only immutable live-artifact history (UI · components/panels).
import { useEffect, useState } from 'react';
import {
  listArtifactVersions,
  type ArtifactVersionSummary,
} from '../../lib/api';
import { humanizeError } from '../../lib/friendly-error';
import { Button } from '../ui/Button';
import { Empty, ErrorState, Loading } from '../ui/StateViews';

function versionTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

export function ArtifactVersionHistoryList({ versions }: { versions: ArtifactVersionSummary[] }) {
  if (!versions.length) {
    return <Empty title="暂无版本记录" message="此活页还没有可复核的版本。" />;
  }
  return (
    <ol className="artifact-list" aria-label="不可变产物版本链">
      {versions.map((version) => (
        <li className="artifact-panel-card" key={version.id}>
          <div className="artifact-panel-head">
            <code>{version.id}</code>
            <span>{versionTime(version.createdAt)}</span>
          </div>
          <p>{version.parentVersionId ? `父版本 ${version.parentVersionId}` : '初始版本'}</p>
          <p>
            {version.hashVerified ? '哈希已验证' : '旧版未存储哈希'}
            {' · '}
            <code title={version.contentSha256}>{version.contentSha256.slice(0, 12)}…</code>
          </p>
        </li>
      ))}
    </ol>
  );
}

export function ArtifactVersionHistory({
  artifactId,
  trustedRoot,
  onClose,
}: {
  artifactId: string;
  trustedRoot: string;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<ArtifactVersionSummary[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setError('');
    listArtifactVersions(artifactId, trustedRoot)
      .then((next) => {
        if (alive) setVersions(next);
      })
      .catch((cause) => {
        if (alive) setError(humanizeError(cause, { action: '读取产物版本历史' }));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => { alive = false; };
  }, [artifactId, trustedRoot]);

  return (
    <aside className="observe-detail" aria-label="产物版本历史" aria-busy={busy}>
      <div className="observe-head">
        <h3>版本历史</h3>
        <Button size="sm" onClick={onClose}>关闭</Button>
      </div>
      <p className="panel-note">历史版本只读保留；当前界面不提供未审批的恢复或覆盖操作。</p>
      {busy && <Loading message="正在读取版本历史…" />}
      {!busy && error && <ErrorState title="版本历史加载失败" message={error} />}
      {!busy && !error && <ArtifactVersionHistoryList versions={versions} />}
    </aside>
  );
}
