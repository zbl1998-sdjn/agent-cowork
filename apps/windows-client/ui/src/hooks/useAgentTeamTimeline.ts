// useAgentTeamTimeline(UI · hooks):从 run history 装配最新 orchestrator 时间线。
// ---------------------------------------------------------------------------
// 依赖 lib/api 单一入口面;组件层只接收纯 view model。
import { useCallback, useEffect, useState } from 'react';
import { getRunRecord, listRunRecords } from '../lib/api';
import { buildAgentTeamTimelineView, isOrchestratorRecord, type AgentTeamTimelineView } from '../lib/agent-team-timeline';
import { humanizeError } from '../lib/friendly-error';

interface UseAgentTeamTimelineOptions {
  enabled?: boolean;
  limit?: number;
}

export interface AgentTeamTimelineState {
  view: AgentTeamTimelineView | null;
  loading: boolean;
  error: string;
  refresh: () => void;
}

export function useAgentTeamTimeline({ enabled = true, limit = 30 }: UseAgentTeamTimelineOptions = {}): AgentTeamTimelineState {
  const [view, setView] = useState<AgentTeamTimelineView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);
  const refresh = useCallback(() => setRefreshTick((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) {
      setView(null);
      setLoading(false);
      setError('');
      return;
    }
    let alive = true;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const records = await listRunRecords(limit);
        const latest = records.find(isOrchestratorRecord);
        if (!latest) {
          if (alive) setView(null);
          return;
        }
        const detail = await getRunRecord(latest.id);
        const nextView = buildAgentTeamTimelineView(detail);
        if (alive) setView(nextView);
      } catch (err) {
        if (alive) {
          setError(humanizeError(err, { action: '读取 Agent Team' }));
          setView(null);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [enabled, limit, refreshTick]);

  return { view, loading, error, refresh };
}
