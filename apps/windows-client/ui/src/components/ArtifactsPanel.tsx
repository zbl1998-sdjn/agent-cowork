import { useEffect, useState } from 'react';
import { listArtifacts, openPath, type ArtifactItem } from '../lib/api';

interface ArtifactsPanelProps { trustedRoot: string }

function humanSize(n?: number): string {
  if (!n || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Lists the work products the agent has saved under .KimiCowork/artifacts. Each
// can be opened in the OS, or previewed via the host's live-artifact page.
export function ArtifactsPanel({ trustedRoot }: ArtifactsPanelProps) {
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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

  return (
    <section className="side-panel">
      <h2>产物</h2>
      <div className="panel-row">
        <button type="button" disabled={busy} onClick={() => void refresh()}>{busy ? '刷新中…' : '刷新'}</button>
      </div>
      <ul className="tool-list">
        {items.map((it) => (
          <li key={it.path}>
            <code>{it.name}</code>
            <span className="tool-src">{it.kind || 'file'}{it.size ? ` · ${humanSize(it.size)}` : ''}</span>
            {it.relativePath && <p>{it.relativePath}</p>}
            <div className="panel-row">
              <button type="button" onClick={() => void openPath(it.path)}>在系统中打开</button>
            </div>
          </li>
        ))}
        {items.length === 0 && !error && <li className="panel-empty">还没有产物。完成一次任务后会出现在这里。</li>}
      </ul>
      {error && <pre className="panel-result">错误：{error}</pre>}
    </section>
  );
}
