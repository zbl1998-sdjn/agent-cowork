import { useRef, useState } from 'react';
import { fetchLiveArtifactData, openPath, type LiveArtifactData } from '../lib/api';

export interface LiveArtifactViewModel {
  srcDoc?: string;
  dataUrl?: string;
  filePath?: string;
  busy?: boolean;
  refreshing?: boolean;
  error?: string;
}

export function liveArtifactViewState(model: LiveArtifactViewModel) {
  const hasArtifact = Boolean(model.srcDoc);
  const canRefresh = hasArtifact && Boolean(model.dataUrl) && !model.busy && !model.refreshing;
  const canOpen = Boolean(model.filePath) && !model.busy;
  return {
    hasArtifact,
    canRefresh,
    canOpen,
    isError: Boolean(model.error),
    refreshLabel: model.refreshing ? '刷新中...' : '刷新数据',
    statusText: model.error || (hasArtifact ? '活页已就绪' : '尚未生成活页'),
  };
}

interface LiveArtifactViewProps extends LiveArtifactViewModel {
  title?: string;
  onRefreshed?: (data: LiveArtifactData) => void;
}

export function LiveArtifactView({
  title = '活页 Artifact',
  srcDoc = '',
  dataUrl = '',
  filePath = '',
  busy = false,
  error = '',
  onRefreshed,
}: LiveArtifactViewProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [lastRefresh, setLastRefresh] = useState('');
  const state = liveArtifactViewState({ srcDoc, dataUrl, filePath, busy, refreshing, error: refreshError || error });

  const refresh = async () => {
    if (!state.canRefresh || !dataUrl) return;
    setRefreshing(true);
    setRefreshError('');
    try {
      const data = await fetchLiveArtifactData(dataUrl);
      frameRef.current?.contentWindow?.postMessage({ type: 'agent-cowork:live-artifact-data', viz: data.viz }, '*');
      setLastRefresh(data.refreshedAt || new Date().toISOString());
      onRefreshed?.(data);
    } catch (e) {
      setRefreshError((e as Error).message || '刷新失败');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="live-artifact-view">
      <div className="panel-row live-artifact-actions">
        <strong>{title}</strong>
        <button type="button" disabled={!state.canRefresh} onClick={() => void refresh()}>{state.refreshLabel}</button>
        {filePath && <button type="button" disabled={!state.canOpen} onClick={() => void openPath(filePath)}>打开文件</button>}
      </div>
      <p className={state.isError ? 'panel-error' : 'panel-note'}>
        {state.statusText}{lastRefresh ? ` · ${new Date(lastRefresh).toLocaleString()}` : ''}
      </p>
      {srcDoc && <iframe ref={frameRef} className="viz-frame" title={title} srcDoc={srcDoc} sandbox="allow-scripts" />}
    </div>
  );
}
