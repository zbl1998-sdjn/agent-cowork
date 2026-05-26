import type { ChangeEvent, KeyboardEvent } from 'react';
import { useEffect, useState } from 'react';
import { listArtifacts, openPath, renameArtifact, type ArtifactItem } from '../../lib/api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Empty, ErrorState } from '../ui/StateViews';

interface ArtifactsPanelProps { trustedRoot: string }

export function humanArtifactSize(n?: number): string {
  if (!n || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function artifactMeta(item: ArtifactItem): string {
  const parts = [item.kind || 'file'];
  const size = humanArtifactSize(item.size);
  if (size) parts.push(size);
  return parts.join(' · ');
}

export function sanitizeArtifactRename(value: string): string {
  const name = value.trim();
  if (!name) return '';
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') return '';
  return name;
}

export function ArtifactsPanelStateViews({ error, onRetry }: { error: string; onRetry: () => void }) {
  if (error) {
    return <ErrorState title="产物加载失败" message={error} onRetry={onRetry} retryLabel="重新加载" />;
  }
  return <Empty title="还没有产物" message="完成一次任务后会出现在这里。" />;
}

export interface ArtifactPanelItemProps {
  item: ArtifactItem;
  busy: boolean;
  renaming: boolean;
  renameText: string;
  onRenameTextChange: (value: string) => void;
  onCommitRename: (item: ArtifactItem) => void;
  onCancelRename: () => void;
  onOpen: (path: string) => void;
  onBeginRename: (item: ArtifactItem) => void;
}

export function ArtifactPanelItem({
  item,
  busy,
  renaming,
  renameText,
  onRenameTextChange,
  onCommitRename,
  onCancelRename,
  onOpen,
  onBeginRename,
}: ArtifactPanelItemProps) {
  const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      onCommitRename(item);
    }
  };
  return (
    <li className="artifact-panel-card" key={item.path}>
      <div className="artifact-panel-head">
        <code>{item.name}</code>
        <span>{artifactMeta(item)}</span>
      </div>
      {item.relativePath && <p>{item.relativePath}</p>}
      {renaming && (
        <div className="panel-row">
          <Input
            aria-label={`重命名 ${item.name}`}
            value={renameText}
            onChange={(event: ChangeEvent<HTMLInputElement>) => onRenameTextChange(event.target.value)}
            onKeyDown={onRenameKeyDown}
          />
          <Button variant="primary" disabled={busy || !sanitizeArtifactRename(renameText)} onClick={() => onCommitRename(item)}>保存</Button>
          <Button variant="secondary" disabled={busy} onClick={onCancelRename}>取消</Button>
        </div>
      )}
      <div className="panel-row">
        <Button variant="secondary" onClick={() => onOpen(item.path)}>打开</Button>
        <Button variant="secondary" disabled={busy} onClick={() => onBeginRename(item)}>重命名</Button>
      </div>
    </li>
  );
}

// Lists the work products the agent has saved under .AgentCowork/artifacts. Each
// can be opened in the OS, or previewed via the host's live-artifact page.
export function ArtifactsPanel({ trustedRoot }: ArtifactsPanelProps) {
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [renamingPath, setRenamingPath] = useState('');
  const [renameText, setRenameText] = useState('');

  const refresh = async () => {
    setBusy(true);
    setError('');
    try {
      setItems(await listArtifacts(trustedRoot, 50));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void refresh(); }, [trustedRoot]);

  const beginRename = (item: ArtifactItem) => {
    setError('');
    setRenamingPath(item.path);
    setRenameText(item.name);
  };

  const commitRename = async (item: ArtifactItem) => {
    const newName = sanitizeArtifactRename(renameText);
    if (!newName) {
      setError('请输入有效文件名，不能包含路径分隔符。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await renameArtifact(item.path, newName, trustedRoot);
      setRenamingPath('');
      setRenameText('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="side-panel">
      <h2>产物</h2>
      <div className="panel-row">
        <Button variant="secondary" disabled={busy} onClick={() => void refresh()}>{busy ? '刷新中…' : '刷新'}</Button>
      </div>
      <ul className="artifact-list">
        {items.map((it) => (
          <ArtifactPanelItem
            key={it.path}
            item={it}
            busy={busy}
            renaming={renamingPath === it.path}
            renameText={renameText}
            onRenameTextChange={setRenameText}
            onCommitRename={(item) => void commitRename(item)}
            onCancelRename={() => { setRenamingPath(''); setRenameText(''); }}
            onOpen={(targetPath) => void openPath(targetPath)}
            onBeginRename={beginRename}
          />
        ))}
        {items.length === 0 && !error && (
          <li className="panel-empty">
            <ArtifactsPanelStateViews error="" onRetry={() => void refresh()} />
          </li>
        )}
      </ul>
      {error && <ArtifactsPanelStateViews error={error} onRetry={() => void refresh()} />}
    </section>
  );
}
