import { useCallback, useEffect, useMemo, useState } from 'react';
import { getRunRecord, listRunRecords, openPath } from '../../lib/api';
import { buildRunObservabilityView, selectInitialRunId, type ObservabilityRow } from '../../lib/run-observability';
import type { RunRecord } from '../../lib/types';
import { Empty, ErrorState } from '../ui/StateViews';

function runTitle(record: RunRecord): string {
  return record.promptPreview || record.prompt || record.id;
}

function runMeta(record: RunRecord): string {
  return [record.type, record.status, record.startedAt ? new Date(record.startedAt).toLocaleString() : ''].filter(Boolean).join(' · ');
}

export function ObservabilityEmptyState({ title, message }: { title: string; message?: string }) {
  return <Empty title={title} message={message} />;
}

export function ObservabilityErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  if (!error) return null;
  return <ErrorState title="运行记录加载失败" message={error} onRetry={onRetry} retryLabel="重新加载" />;
}

function Rows({ empty, rows }: { empty: string; rows: ObservabilityRow[] }) {
  if (!rows.length) return <ObservabilityEmptyState title={empty} />;
  return (
    <dl className="observe-rows">
      {rows.map((item) => (
        <div key={`${item.label}:${item.value}`} className="observe-row">
          <dt>{item.label}</dt>
          <dd>{item.path ? <button type="button" onClick={() => void openPath(item.path!)}>{item.value}</button> : item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ObservabilityPanel() {
  const [records, setRecords] = useState<RunRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<RunRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [error, setError] = useState('');

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = await listRunRecords(30);
      setRecords(next);
      setSelectedId((current) => selectInitialRunId(next, current));
      if (!next.length) setSelected(null);
    } catch (err) {
      setError((err as Error).message || '读取运行记录失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    let alive = true;
    setDetailBusy(true);
    getRunRecord(selectedId)
      .then((record) => {
        if (!alive) return;
        setSelected(record);
        setRecords((current) => current.map((item) => (item.id === record.id ? { ...item, ...record } : item)));
      })
      .catch((err) => {
        if (!alive) return;
        setError((err as Error).message || '读取运行详情失败');
        setSelected(null);
      })
      .finally(() => {
        if (alive) setDetailBusy(false);
      });
    return () => { alive = false; };
  }, [selectedId]);

  const view = useMemo(() => buildRunObservabilityView(selected), [selected]);

  return (
    <section className="side-panel observability-panel">
      <div className="observe-head">
        <h2>成本 / 可观测</h2>
        <button type="button" onClick={() => void loadRuns()} disabled={loading}>{loading ? '刷新中' : '刷新'}</button>
      </div>
      <ObservabilityErrorState error={error} onRetry={() => void loadRuns()} />
      <div className="observe-layout">
        <ul className="observe-run-list">
          {records.map((record) => (
            <li key={record.id}>
              <button type="button" className={record.id === selectedId ? 'is-selected' : ''} onClick={() => setSelectedId(record.id)}>
                <strong>{runTitle(record)}</strong>
                <span>{runMeta(record)}</span>
              </button>
            </li>
          ))}
          {!records.length && (
            <li className="panel-empty">
              <ObservabilityEmptyState title="暂无运行记录" message="完成一次 agent 运行后会显示在这里。" />
            </li>
          )}
        </ul>

        <div className="observe-detail" aria-busy={detailBusy}>
          {selected ? (
            <>
              <div className="observe-title">
                <strong>{view.title}</strong>
                <span>{view.subtitle}</span>
              </div>
              {view.isSparse && <p className="panel-note">当前记录还没有 metrics / attribution，先显示可用占位。</p>}
              <div className="observe-card-grid">
                {view.cards.map((card) => (
                  <div key={card.label} className={`observe-card observe-card-${card.tone}`}>
                    <span>{card.label}</span>
                    <strong>{card.value}</strong>
                    <em>{card.detail}</em>
                  </div>
                ))}
              </div>

              <h3>工具</h3>
              <div className="observe-chips">
                {view.toolNames.map((name) => <code key={name}>{name}</code>)}
                {!view.toolNames.length && <ObservabilityEmptyState title="未记录工具调用" />}
              </div>
              <Rows rows={view.toolReasonRows} empty="未记录工具调用原因" />

              <h3>耗时 / 步骤</h3>
              <Rows rows={view.timingRows} empty="未记录耗时" />

              <h3>模型归因</h3>
              <Rows rows={view.attributionRows} empty="未记录模型归因" />

              <h3>配置快照</h3>
              <Rows rows={view.configRows} empty="未记录配置快照" />

              <h3>来源</h3>
              <Rows rows={view.sourceRows} empty="未记录来源" />
            </>
          ) : (
            <ObservabilityEmptyState title="选择一条运行记录查看明细" message="运行记录列表加载后可查看成本、工具和来源。" />
          )}
        </div>
      </div>
    </section>
  );
}
