import { useState } from 'react';
import { renderViz, liveArtifactUrl, fetchArtifactHtml, openPath } from '../lib/api';

interface VizPanelProps {
  trustedRoot: string;
}

const SAMPLE = JSON.stringify(
  { title: '季度收入', kind: 'bar', data: { labels: ['Q1', 'Q2', 'Q3'], values: [12, 19, 8] } },
  null,
  2,
);

// Render a viz spec to a live, refreshable artifact and preview it inline.
export function VizPanel({ trustedRoot }: VizPanelProps) {
  const [specText, setSpecText] = useState(SAMPLE);
  const [srcDoc, setSrcDoc] = useState('');
  const [filePath, setFilePath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const onRender = async () => {
    setBusy(true);
    setError('');
    setSrcDoc('');
    try {
      const spec = JSON.parse(specText);
      const res = await renderViz(spec, true, trustedRoot);
      // Fetch the live artifact HTML WITH the token, then render it in a
      // sandboxed iframe via srcDoc (an iframe src can't carry the bearer token).
      if (res.viewUrl) setSrcDoc(await fetchArtifactHtml(liveArtifactUrl(res.viewUrl)));
      setFilePath(res.relativePath ? `${trustedRoot}/${res.relativePath}` : '');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="side-panel">
      <h2>可视化 / 活页</h2>
      <textarea value={specText} rows={8} spellCheck={false} onChange={(e) => setSpecText(e.target.value)} />
      <div className="panel-row">
        <button type="button" disabled={busy} onClick={() => void onRender()}>{busy ? '渲染中…' : '渲染活页'}</button>
        {filePath && <button type="button" onClick={() => void openPath(filePath)}>打开文件</button>}
      </div>
      {error && <p className="panel-error">{error}</p>}
      {srcDoc && <iframe className="viz-frame" title="活页 Artifact" srcDoc={srcDoc} sandbox="allow-scripts" />}
    </section>
  );
}
