// AgentTeamTimeline(UI · components):右侧栏多 Agent 编排时间线。纯展示+回调。
import type { AgentTeamTimelineView } from '../lib/agent-team-timeline';
import { Icon } from './ui/Icon';

interface AgentTeamTimelineProps {
  view: AgentTeamTimelineView | null;
  loading?: boolean;
  error?: string;
  onRefresh?: (() => void) | undefined;
  onOpenRuns?: (() => void) | undefined;
}

function ToneDot({ tone }: { tone: AgentTeamTimelineView['tone'] | 'neutral' }) {
  return <span className={`agent-team-dot is-${tone}`} aria-hidden="true" />;
}

export function AgentTeamTimeline({ view, loading = false, error = '', onRefresh, onOpenRuns }: AgentTeamTimelineProps) {
  return (
    <section className="context-card agent-team-card" aria-label="Agent Team Timeline">
      <div className="context-card-head agent-team-head">
        <Icon name="observability" size={14} />
        <span>Agent Team</span>
        {view ? <span className={`agent-team-status is-${view.tone}`}>{view.statusLabel}</span> : null}
        <div className="agent-team-actions">
          {onRefresh ? (
            <button type="button" className="agent-team-action" onClick={onRefresh} title="刷新 Agent Team" aria-label="刷新 Agent Team" disabled={loading}>
              <Icon name="history" size={13} />
            </button>
          ) : null}
          {onOpenRuns ? (
            <button type="button" className="agent-team-action" onClick={onOpenRuns} title="打开运行记录" aria-label="打开运行记录">
              <Icon name="observability" size={13} />
            </button>
          ) : null}
        </div>
      </div>

      {!view ? (
        <div className="agent-team-empty">
          <span>{loading ? '读取中' : '暂无多 Agent 运行'}</span>
          {error ? <em>{error}</em> : null}
        </div>
      ) : (
        <>
          <div className="agent-team-title" title={view.title}>{view.title}</div>
          <div className="agent-team-subtitle" title={view.subtitle}>{view.subtitle}</div>

          <div className="agent-team-metrics">
            <div><span>成员</span><strong>{view.agentCount}</strong></div>
            <div><span>事件</span><strong>{view.eventCount}</strong></div>
            <div><span>证据</span><strong>{view.evidenceCount}</strong></div>
            <div><span>警告</span><strong>{view.warningCount}</strong></div>
          </div>

          <ol className="agent-team-agents" aria-label="Agent 成员状态">
            {view.agents.slice(0, 5).map((agent) => (
              <li key={agent.id} className={`agent-team-agent is-${agent.tone}`}>
                <ToneDot tone={agent.tone} />
                <div>
                  <strong>{agent.label}</strong>
                  <span title={agent.taskTitle}>{agent.taskTitle}</span>
                  <em>{agent.statusLabel} · 置信 {agent.confidence} · {agent.usage}</em>
                </div>
              </li>
            ))}
          </ol>

          <ol className="agent-team-events" aria-label="Agent Team 时间线">
            {view.events.slice(-5).map((event) => (
              <li key={event.key} className={`agent-team-event is-${event.tone}`}>
                <span>{event.at}</span>
                <ToneDot tone={event.tone} />
                <div>
                  <strong>{event.label} · {event.actor}</strong>
                  <em title={event.detail}>{event.detail}</em>
                </div>
              </li>
            ))}
          </ol>

          {view.budgets.length ? (
            <div className="agent-team-budget" aria-label="Agent Team 预算">
              {view.budgets.slice(0, 4).map((budget) => (
                <div key={budget.key} className="agent-team-budget-row">
                  <span>{budget.label}</span>
                  <strong>{budget.used}</strong>
                  <em>{budget.percent}% · 余 {budget.remaining}</em>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
