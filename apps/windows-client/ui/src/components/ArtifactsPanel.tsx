import { useEffect, useState } from 'react';
import { listArtifacts, openPath, renameArtifact, type ArtifactItem } from '../lib/api';

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
        <button type="button" disabled={busy} onClick={() => void refresh()}>{busy ? '刷新中…' : '刷新'}</button>
      </div>
      <ul className="artifact-list">
        {items.map((it) => (
          <li className="artifact-panel-card" key={it.path}>
            <div className="artifact-panel-head">
              <code>{it.name}</code>
              <span>{artifactMeta(it)}</span>
            </div>
            {it.relativePath && <p>{it.relativePath}</p>}
            {renamingPath === it.path && (
              <div className="panel-row">
                <input value={renameText} onChange={(e) => setRenameText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(it); }} />
                <button type="button" disabled={busy || !sanitizeArtifactRename(renameText)} onClick={() => void commitRename(it)}>保存</button>
                <button type="button" disabled={busy} onClick={() => { setRenamingPath(''); setRenameText(''); }}>取消</button>
              </div>
            )}
            <div className="panel-row">
              <button type="button" onClick={() => void openPath(it.path)}>打开</button>
              <button type="button" disabled={busy} onClick={() => beginRename(it)}>重命名</button>
            </div>
          </li>
        ))}
        {items.length === 0 && !error && <li className="panel-empty">还没有产物。完成一次任务后会出现在这里。</li>}
      </ul>
      {error && <pre className="panel-result">错误：{error}</pre>}
    </section>
  );
}
