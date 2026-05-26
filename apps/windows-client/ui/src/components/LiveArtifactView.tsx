import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchLiveArtifactData, openPath, type LiveArtifactData } from '../lib/api';
import { Button } from './ui/Button';
import { Empty, ErrorState, Loading } from './ui/StateViews';

export const DEFAULT_AUTO_REFRESH_SECONDS = 5;
export const MIN_AUTO_REFRESH_SECONDS = 1;
export const MAX_AUTO_REFRESH_SECONDS = 60;

export interface LiveArtifactViewModel {
  srcDoc?: string;
  dataUrl?: string;
  filePath?: string;
  busy?: boolean;
  refreshing?: boolean;
  error?: string;
  autoRefresh?: boolean;
  autoRefreshSeconds?: number;
}

export function normaliseAutoRefreshSeconds(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_AUTO_REFRESH_SECONDS;
  return Math.min(MAX_AUTO_REFRESH_SECONDS, Math.max(MIN_AUTO_REFRESH_SECONDS, Math.floor(parsed)));
}

export function liveArtifactViewState(model: LiveArtifactViewModel) {
  const hasArtifact = Boolean(model.srcDoc);
  const canRefresh = hasArtifact && Boolean(model.dataUrl) && !model.busy && !model.refreshing;
  const autoRefreshSeconds = normaliseAutoRefreshSeconds(model.autoRefreshSeconds);
  const autoRefresh = Boolean(model.autoRefresh) && canRefresh;
  const canOpen = Boolean(model.filePath) && !model.busy;
  return {
    hasArtifact,
    canRefresh,
    canAutoRefresh: hasArtifact && Boolean(model.dataUrl) && !model.busy,
    autoRefresh,
    autoRefreshSeconds,
    canOpen,
    isError: Boolean(model.error),
    refreshLabel: model.refreshing ? '刷新中...' : '刷新数据',
    autoRefreshLabel: autoRefresh ? `自动刷新 ${autoRefreshSeconds}s` : '自动刷新',
    statusText: model.error || (hasArtifact ? '活页已就绪' : '尚未生成活页'),
  };
}

type LiveArtifactRenderState = ReturnType<typeof liveArtifactViewState>;

export function LiveArtifactStatusView({
  busy,
  lastRefresh = '',
  state,
}: {
  busy?: boolean;
  lastRefresh?: string;
  state: LiveArtifactRenderState;
}) {
  if (state.isError) {
    return <ErrorState title="活页刷新失败" message={state.statusText} />;
  }
  if (busy && !state.hasArtifact) {
    return <Loading message="正在生成活页…" />;
  }
  if (!state.hasArtifact) {
    return <Empty title="尚未生成活页" message="渲染完成后会在这里预览。" />;
  }
  return (
    <p className="panel-note">
      {state.statusText}{lastRefresh ? ` · ${new Date(lastRefresh).toLocaleString()}` : ''}
    </p>
  );
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
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState(DEFAULT_AUTO_REFRESH_SECONDS);
  const state = liveArtifactViewState({
    srcDoc,
    dataUrl,
    filePath,
    busy,
    refreshing,
    error: refreshError || error,
    autoRefresh,
    autoRefreshSeconds,
  });

  const refresh = useCallback(async () => {
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
  }, [dataUrl, onRefreshed, state.canRefresh]);

  useEffect(() => {
    if (!state.autoRefresh || !state.canRefresh) return undefined;
    const interval = window.setInterval(() => {
      void refresh();
    }, state.autoRefreshSeconds * 1000);
    return () => window.clearInterval(interval);
  }, [refresh, state.autoRefresh, state.canRefresh, state.autoRefreshSeconds]);

  return (
    <div className="live-artifact-view">
      <div className="panel-row live-artifact-actions">
        <strong>{title}</strong>
        <Button variant="secondary" disabled={!state.canRefresh} onClick={() => void refresh()}>{state.refreshLabel}</Button>
        {filePath && <Button variant="secondary" disabled={!state.canOpen} onClick={() => void openPath(filePath)}>打开文件</Button>}
        <label className="live-artifact-auto">
          <input
            type="checkbox"
            checked={autoRefresh}
            disabled={!state.canAutoRefresh}
            onChange={(event) => setAutoRefresh(event.target.checked)}
          />
          <span>{state.autoRefreshLabel}</span>
        </label>
        <input
          className="live-artifact-interval"
          aria-label="自动刷新间隔秒"
          type="number"
          min={MIN_AUTO_REFRESH_SECONDS}
          max={MAX_AUTO_REFRESH_SECONDS}
          value={autoRefreshSeconds}
          disabled={!autoRefresh || !state.canAutoRefresh}
          onChange={(event) => setAutoRefreshSeconds(normaliseAutoRefreshSeconds(event.target.value))}
        />
      </div>
      <LiveArtifactStatusView busy={busy} lastRefresh={lastRefresh} state={state} />
      {srcDoc && <iframe ref={frameRef} className="viz-frame" title={title} srcDoc={srcDoc} sandbox="allow-scripts" />}
    </div>
  );
}
