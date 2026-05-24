import { useEffect, useState } from 'react';
import { previewFile, openPath, type FilePreviewResult } from '../lib/api';
import { renderMarkdown } from '../lib/md';

interface FilePreviewProps {
  path: string;
  trustedRoot?: string;
  onClose: () => void;
}

// Inline preview modal for produced artifacts: images render via a data: URL
// (allowed by the desktop CSP), markdown is rendered, text shows as <pre>, and
// PDF / unknown types fall back to "open with the system app".
export function FilePreview({ path, trustedRoot, onClose }: FilePreviewProps) {
  const [data, setData] = useState<FilePreviewResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(''); setData(null);
    previewFile(path, trustedRoot)
      .then((d) => { if (alive) { setData(d); setLoading(false); } })
      .catch((e) => { if (alive) { setError((e as Error).message || '预览失败'); setLoading(false); } });
    return () => { alive = false; };
  }, [path, trustedRoot]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const name = data?.name || path.split(/[\\/]/).pop() || '文件';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card preview-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="文件预览">
        <header className="modal-head">
          <h2 className="preview-title" title={name}>{name}</h2>
          <div className="preview-head-actions">
            <button type="button" className="btn-secondary" onClick={() => void openPath(path)}>用系统打开</button>
            <button type="button" className="modal-close" aria-label="关闭" onClick={onClose}>×</button>
          </div>
        </header>
        <div className="preview-content">
          {loading && <div className="modal-loading">加载预览…</div>}
          {error && <div className="auth-error" role="alert">{error}</div>}
          {data?.kind === 'image' && data.base64 && (
            <img className="preview-image" src={`data:${data.mime};base64,${data.base64}`} alt={name} />
          )}
          {data?.kind === 'markdown' && data.text != null && (
            <div className="message-text preview-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(data.text) }} />
          )}
          {data?.kind === 'text' && data.text != null && (
            <pre className="preview-text">{data.text}</pre>
          )}
          {data?.kind === 'diff' && data.text != null && (
            <pre className="preview-text preview-diff">{data.text}</pre>
          )}
          {data?.kind === 'table' && data.table && (
            <div className="preview-table-wrap">
              <table className="preview-table">
                <thead>
                  <tr>{data.table.headers.map((cell, i) => <th key={i}>{cell}</th>)}</tr>
                </thead>
                <tbody>
                  {data.table.rows.map((row, r) => (
                    <tr key={r}>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>
                  ))}
                </tbody>
              </table>
              {data.table.truncated && <p className="modal-note">仅显示前 100 行。</p>}
            </div>
          )}
          {data?.kind === 'pdf' && data.base64 && (
            <div className="preview-pdf-wrap">
              {/* Use an <iframe> (governed by CSP frame-src) rather than <embed>
                  (object-src) so the CSP can lock object-src down to 'none'.
                  WebView2/Chromium renders a data: PDF URL with its built-in viewer. */}
              <iframe className="preview-pdf" title={name} src={`data:application/pdf;base64,${data.base64}`} />
            </div>
          )}
          {data?.kind === 'other' && (
            <div className="preview-fallback">
              <p>该文件类型暂不支持内联预览。</p>
              <button type="button" className="btn-primary" onClick={() => void openPath(path)}>用系统打开</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
