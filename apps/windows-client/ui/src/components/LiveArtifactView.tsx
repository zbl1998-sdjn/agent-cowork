import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchLiveArtifactData, openPath, type LiveArtifactData } from '../lib/api';
import { Button } from './ui/Button';
import { Empty, ErrorState, Loading } from './ui/StateViews';

export const DEFAULT_AUTO_REFRESH_SECONDS = 5;
export const MIN_AUTO_REFRESH_SECONDS = 1;
export const MAX_AUTO_REFRESH_SECONDS = 60;

export const HEIGHT_PRESETS: Array<{ key: 's' | 'm' | 'l' | 'xl'; label: string; px: number }> = [
  { key: 's', label: '小', px: 320 },
  { key: 'm', label: '中', px: 520 },
  { key: 'l', label: '大', px: 760 },
  { key: 'xl', label: '加大', px: 1080 },
];

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2;
export const ZOOM_STEP = 0.1;

export interface LiveArtifactViewModel {
  srcDoc?: string;
  dataUrl?: string;
  filePath?: string;
  viewUrl?: string;
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

export function clampZoom(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
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
  if (state.isError) return <ErrorState title="活页刷新失败" message={state.statusText} />;
  if (busy && !state.hasArtifact) return <Loading message="正在生成活页…" />;
  if (!state.hasArtifact) return <Empty title="尚未生成活页" message="渲染完成后会在这里预览。" />;
  return <p className="panel-note">{state.statusText}{lastRefresh ? ` · ${new Date(lastRefresh).toLocaleString()}` : ''}</p>;
}

function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return Promise.resolve(false);
  try {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

function downloadHtml(srcDoc: string, suggestedName = 'artifact.html') {
  if (!srcDoc) return;
  const blob = new Blob([srcDoc], { type: 'text/html;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href; a.download = suggestedName;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(href), 1000);
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
  viewUrl = '',
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
  const [heightKey, setHeightKey] = useState<'s' | 'm' | 'l' | 'xl'>('m');
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState('');

  const state = liveArtifactViewState({
    srcDoc, dataUrl, filePath, busy, refreshing,
    error: refreshError || error, autoRefresh, autoRefreshSeconds,
  });

  const heightPx = useMemo(() => HEIGHT_PRESETS.find((p) => p.key === heightKey)?.px ?? 520, [heightKey]);

  const refresh = useCallback(async () => {
    if (!state.canRefresh || !dataUrl) return;
    setRefreshing(true); setRefreshError('');
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
    const interval = window.setInterval(() => { void refresh(); }, state.autoRefreshSeconds * 1000);
    return () => window.clearInterval(interval);
  }, [refresh, state.autoRefresh, state.canRefresh, state.autoRefreshSeconds]);

  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const flashCopied = (what: string) => { setCopied(what); window.setTimeout(() => setCopied(''), 1400); };
  const onCopyView = async () => { if (await copyToClipboard(viewUrl)) flashCopied('view'); };
  const onCopyData = async () => { if (await copyToClipboard(dataUrl)) flashCopied('data'); };
  const onDownloadHtml = () => downloadHtml(srcDoc);

  // CSS-only zoom: outer wrapper bounds the viewport; the inner box reserves
  // `100% * zoom` so the wrapper scrolls when zoom > 1; the iframe is sized
  // `100% / zoom` then scaled, so at zoom=1 nothing changes — exact math, no
  // empty space at <1, scrollbars at >1, content untouched.
  const innerPct = `${(zoom * 100).toFixed(2)}%`;
  const framePct = `${(100 / zoom).toFixed(4)}%`;

  return (
    <div className={'live-artifact-view' + (fullscreen ? ' is-fullscreen' : '')}>
      <div className="panel-row live-artifact-actions">
        <strong>{title}</strong>
        <Button variant="secondary" disabled={!state.canRefresh} onClick={() => void refresh()}>{state.refreshLabel}</Button>
        {filePath && <Button variant="secondary" disabled={!state.canOpen} onClick={() => void openPath(filePath)}>打开文件</Button>}
        <label className="live-artifact-auto">
          <input type="checkbox" checked={autoRefresh} disabled={!state.canAutoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          <span>{state.autoRefreshLabel}</span>
        </label>
        <input className="live-artifact-interval" aria-label="自动刷新间隔秒" type="number"
               min={MIN_AUTO_REFRESH_SECONDS} max={MAX_AUTO_REFRESH_SECONDS}
               value={autoRefreshSeconds} disabled={!autoRefresh || !state.canAutoRefresh}
               onChange={(e) => setAutoRefreshSeconds(normaliseAutoRefreshSeconds(e.target.value))} />
      </div>

      {state.hasArtifact && (
        <div className="panel-row live-artifact-toolbar">
          <span className="viz-toolbar-label">大小</span>
          {HEIGHT_PRESETS.map((p) => (
            <Button key={p.key} variant="secondary" className={heightKey === p.key ? 'is-active' : ''}
                    onClick={() => setHeightKey(p.key)} title={`高度 ${p.px}px`}>{p.label}</Button>
          ))}
          <span className="viz-toolbar-sep">·</span>
          <span className="viz-toolbar-label">缩放</span>
          <Button variant="secondary" onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))} title="缩小">−</Button>
          <span className="viz-zoom-value">{Math.round(zoom * 100)}%</span>
          <Button variant="secondary" onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))} title="放大">+</Button>
          <Button variant="secondary" onClick={() => setZoom(1)} title="重置为 100%">1:1</Button>
          <span className="viz-toolbar-sep">·</span>
          <Button variant="secondary" onClick={() => setFullscreen((v) => !v)}>{fullscreen ? '退出全屏' : '全屏'}</Button>
          <span className="viz-toolbar-sep">·</span>
          {viewUrl && <Button variant="secondary" onClick={() => void onCopyView()}>{copied === 'view' ? '已复制 ✓' : '复制活页链接'}</Button>}
          {dataUrl && <Button variant="secondary" onClick={() => void onCopyData()}>{copied === 'data' ? '已复制 ✓' : '复制数据链接'}</Button>}
          <Button variant="secondary" onClick={onDownloadHtml}>下载 HTML</Button>
        </div>
      )}

      <LiveArtifactStatusView busy={busy} lastRefresh={lastRefresh} state={state} />
      {srcDoc && (
        <div className="viz-frame-wrapper" style={{ height: fullscreen ? 'calc(100vh - 140px)' : `${heightPx}px` }}>
          <div className="viz-frame-inner" style={{ width: innerPct, height: innerPct }}>
            <iframe
              ref={frameRef}
              className="viz-frame"
              title={title}
              srcDoc={srcDoc}
              sandbox="allow-scripts"
              style={{ transform: `scale(${zoom})`, transformOrigin: 'top left', width: framePct, height: framePct }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
