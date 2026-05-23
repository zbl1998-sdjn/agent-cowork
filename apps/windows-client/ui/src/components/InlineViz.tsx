import { useEffect, useState } from 'react';
import { renderViz, type VizSpec } from '../lib/api';

// Renders a viz spec inline in the conversation by asking the host to render it
// (persist:false) and embedding the returned self-contained HTML in an iframe.
export function InlineViz({ spec, trustedRoot }: { spec: VizSpec; trustedRoot?: string }) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  const key = JSON.stringify(spec);

  useEffect(() => {
    let alive = true;
    setHtml('');
    setError('');
    renderViz(spec, false, trustedRoot)
      .then((r) => { if (alive) setHtml(r.html); })
      .catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, trustedRoot]);

  if (error) return <div className="panel-error">图表渲染失败：{error}</div>;
  if (!html) return <div className="inline-viz-loading">渲染图表中…</div>;
  return <iframe className="inline-viz-frame" title="inline-viz" srcDoc={html} sandbox="allow-scripts" />;
}
