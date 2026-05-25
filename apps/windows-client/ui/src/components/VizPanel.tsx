import { useState } from 'react';
import { renderViz, liveArtifactUrl, fetchArtifactHtml } from '../lib/api';
import { LiveArtifactView } from './LiveArtifactView';
import { ErrorState } from './ui/StateViews';

interface VizPanelProps {
  trustedRoot: string;
}

const SAMPLE = JSON.stringify(
  { title: '季度收入', kind: 'bar', data: { labels: ['Q1', 'Q2', 'Q3'], values: [12, 19, 8] } },
  null,
  2,
);

export function VizPanelErrorState({ error }: { error: string }) {
  if (!error) return null;
  return <ErrorState title="活页渲染失败" message={error} />;
}

// Render a viz spec to a live, refreshable artifact and preview it inline.
export function VizPanel({ trustedRoot }: VizPanelProps) {
  const [specText, setSpecText] = useState(SAMPLE);
  const [srcDoc, setSrcDoc] = useState('');
  const [filePath, setFilePath] = useState('');
  const [dataUrl, setDataUrl] = useState('');
  const [viewUrl, setViewUrl] = useState('');
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
      if (res.viewUrl) {
        const resolvedViewUrl = liveArtifactUrl(res.viewUrl);
        setViewUrl(resolvedViewUrl);
        setSrcDoc(await fetchArtifactHtml(resolvedViewUrl));
      } else {
        setViewUrl('');
      }
      setDataUrl(res.dataUrl || '');
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
        {viewUrl && <button type="button" onClick={() => void fetchArtifactHtml(viewUrl).then(setSrcDoc).catch((e) => setError((e as Error).message))}>重开活页</button>}
      </div>
      <VizPanelErrorState error={error} />
      <LiveArtifactView srcDoc={srcDoc} dataUrl={dataUrl} filePath={filePath} busy={busy} />
    </section>
  );
}
