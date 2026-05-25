import { useEffect, useState } from 'react';
import { renderViz, type VizSpec } from '../lib/api';
import { ErrorState, Loading } from './ui/StateViews';

export function InlineVizErrorState({ error }: { error: string }) {
  if (!error) return null;
  return <ErrorState title="图表渲染失败" message={error} />;
}

export function InlineVizLoadingState() {
  return <Loading message="渲染图表中…" />;
}

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

  if (error) return <InlineVizErrorState error={error} />;
  if (!html) return <InlineVizLoadingState />;
  return <iframe className="inline-viz-frame" title="inline-viz" srcDoc={html} sandbox="allow-scripts" />;
}
