// Agent Team Timeline view model(UI · 逻辑层 · lib)
// ---------------------------------------------------------------------------
// 职责:把 host 持久化的 orchestrator run 记录整形成右侧 Agent Team 时间线视图。
// 只依赖 lib/types 的前端契约,不跨层导入 host 类型。
import { formatDurationMs, formatTokenCount } from './usage-display';
import type {
  OrchestratorBudgetSnapshot,
  OrchestratorResult,
  OrchestratorRun,
  OrchestratorTask,
  OrchestratorUsage,
  RunRecord,
} from './types';

export type AgentTeamTone = 'neutral' | 'running' | 'done' | 'warn' | 'danger';

export interface AgentTeamAgentView {
  id: string;
  label: string;
  taskTitle: string;
  statusLabel: string;
  tone: AgentTeamTone;
  summary: string;
  confidence: string;
  usage: string;
  evidenceCount: number;
  warningCount: number;
}

export interface AgentTeamEventView {
  key: string;
  label: string;
  actor: string;
  detail: string;
  at: string;
  tone: AgentTeamTone;
}

export interface AgentTeamBudgetView {
  key: keyof OrchestratorUsage;
  label: string;
  used: string;
  limit: string;
  remaining: string;
  percent: number;
}

export interface AgentTeamTimelineView {
  runId: string;
  title: string;
  subtitle: string;
  statusLabel: string;
  tone: AgentTeamTone;
  agentCount: number;
  eventCount: number;
  evidenceCount: number;
  warningCount: number;
  artifactCount: number;
  agents: AgentTeamAgentView[];
  events: AgentTeamEventView[];
  budgets: AgentTeamBudgetView[];
}

type TimelineEvent = Record<string, unknown>;

const AGENT_LABELS: Record<string, string> = {
  supervisor: '监督员',
  router: '路由员',
  researcher: '研究员',
  writer: '写作者',
  excel_helper: 'Excel 助手',
  ppt_designer: 'PPT 设计师',
  word_polisher: 'Word 润色员',
  file_organizer: '文件整理员',
  verifier: '验证员',
  security_reviewer: '安全审阅',
  fallback_agent: '兜底代理',
};

const EVENT_LABELS: Record<string, string> = {
  run_started: '开始',
  recipe_selected: '配方',
  agent_task_started: '任务开始',
  agent_task_completed: '任务完成',
  agent_task_failed: '任务失败',
  synthesis_started: '汇总',
  verification_completed: '验证',
  budget_updated: '预算',
  run_completed: '结束',
};

const BUDGET_FIELDS: Array<{ key: keyof OrchestratorUsage; label: string }> = [
  { key: 'modelCalls', label: '模型调用' },
  { key: 'toolCalls', label: '工具调用' },
  { key: 'inputTokens', label: '输入' },
  { key: 'outputTokens', label: '输出' },
  { key: 'runtimeMs', label: '耗时' },
  { key: 'filesRead', label: '文件读取' },
  { key: 'bytesRead', label: '读取量' },
];

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function numberValue(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function agentLabel(agentId: string): string {
  return AGENT_LABELS[agentId] || agentId.replace(/_/g, ' ');
}

function shortTime(value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  const match = raw.match(/T(\d{2}:\d{2}:\d{2})/);
  return match?.[1] || raw;
}

function confidenceText(value: unknown): string {
  const n = numberValue(value, NaN);
  if (!Number.isFinite(n)) return '未记录';
  return `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;
}

function usageTokens(usage: OrchestratorUsage | undefined): number {
  return numberValue(usage?.inputTokens) + numberValue(usage?.outputTokens);
}

function usageText(usage: OrchestratorUsage | undefined): string {
  if (!usage) return '未记录';
  const calls = numberValue(usage.modelCalls);
  const tools = numberValue(usage.toolCalls);
  const tokens = usageTokens(usage);
  const parts = [
    calls > 0 ? `${calls.toLocaleString('en-US')} 次模型` : '',
    tools > 0 ? `${tools.toLocaleString('en-US')} 次工具` : '',
    tokens > 0 ? formatTokenCount(tokens) : '',
  ].filter(Boolean);
  return parts.join(' / ') || '0 调用';
}

function usageMetricText(key: keyof OrchestratorUsage, value: unknown): string {
  const n = Math.max(0, Math.round(numberValue(value)));
  if (key === 'inputTokens' || key === 'outputTokens') return formatTokenCount(n);
  if (key === 'runtimeMs') return formatDurationMs(n);
  if (key === 'bytesRead') {
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n.toLocaleString('en-US')} B`;
  }
  return n.toLocaleString('en-US');
}

function runStatusTone(status: string): AgentTeamTone {
  if (status === 'completed' || status === 'done') return 'done';
  if (status === 'failed') return 'danger';
  if (status === 'cancelled' || status === 'waiting_approval') return 'warn';
  if (status === 'running' || status === 'planning' || status === 'synthesizing' || status === 'verifying') return 'running';
  return 'neutral';
}

function resultStatusTone(status: string): AgentTeamTone {
  if (status === 'succeeded') return 'done';
  if (status === 'failed') return 'danger';
  if (status === 'partial' || status === 'skipped') return 'warn';
  if (status === 'running') return 'running';
  return 'neutral';
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    completed: '已完成',
    done: '已完成',
    failed: '失败',
    cancelled: '已取消',
    waiting_approval: '待审批',
    running: '运行中',
    planning: '规划中',
    synthesizing: '汇总中',
    verifying: '验证中',
    succeeded: '成功',
    partial: '部分完成',
    skipped: '跳过',
    idle: '未开始',
  };
  return labels[status] || status || '未知';
}

function eventTone(event: TimelineEvent): AgentTeamTone {
  const type = text(event.type);
  const status = text(event.status);
  if (type === 'agent_task_failed') return 'danger';
  if (type === 'verification_completed' && event.passed === false) return 'warn';
  if (type === 'agent_task_completed') return resultStatusTone(status);
  if (type === 'run_completed') return runStatusTone(status);
  if (type === 'agent_task_started' || type === 'synthesis_started') return 'running';
  return 'neutral';
}

function eventDetail(event: TimelineEvent): string {
  const type = text(event.type);
  if (type === 'run_started') return text(event.goal);
  if (type === 'recipe_selected') return [text(event.recipeId), text(event.reason)].filter(Boolean).join(' · ');
  if (type === 'agent_task_started') return text(event.title);
  if (type === 'agent_task_completed') return text(event.summary) || statusLabel(text(event.status));
  if (type === 'agent_task_failed') return text(event.error);
  if (type === 'verification_completed') {
    const warnings = Array.isArray(event.warnings) ? event.warnings.length : 0;
    return event.passed === false ? `未通过 · ${warnings} 个警告` : `通过 · ${warnings} 个警告`;
  }
  if (type === 'run_completed') return statusLabel(text(event.status));
  if (type === 'budget_updated') return '预算快照已更新';
  return text(event.detail || event.message || event.text);
}

function eventViews(events: TimelineEvent[]): AgentTeamEventView[] {
  return events
    .map((event, index) => {
      const type = text(event.type);
      if (!type) return null;
      const agentId = text(event.agentId);
      const taskId = text(event.taskId);
      return {
        key: `${text(event.at)}:${type}:${agentId || taskId || index}`,
        label: EVENT_LABELS[type] || type,
        actor: agentId ? agentLabel(agentId) : '编排器',
        detail: eventDetail(event),
        at: shortTime(event.at),
        tone: eventTone(event),
      } satisfies AgentTeamEventView;
    })
    .filter((item): item is AgentTeamEventView => Boolean(item))
    .slice(-8);
}

function latestBudget(events: TimelineEvent[]): OrchestratorBudgetSnapshot | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (text(event?.type) === 'budget_updated' && event?.budget && typeof event.budget === 'object') {
      return event.budget as OrchestratorBudgetSnapshot;
    }
  }
  return null;
}

function budgetViews(snapshot: OrchestratorBudgetSnapshot | null): AgentTeamBudgetView[] {
  if (!snapshot) return [];
  return BUDGET_FIELDS.map(({ key, label }) => {
    const used = numberValue(snapshot.used?.[key]);
    const limit = numberValue(snapshot.limit?.[key]);
    const remaining = numberValue(snapshot.remaining?.[key]);
    const percent = limit > 0 ? Math.max(0, Math.min(100, Math.round((used / limit) * 100))) : 0;
    return {
      key,
      label,
      used: usageMetricText(key, used),
      limit: usageMetricText(key, limit),
      remaining: usageMetricText(key, remaining),
      percent,
    };
  }).filter((row) => row.used !== usageMetricText(row.key, 0) || row.limit !== usageMetricText(row.key, 0));
}

function uniqueAgentIds(run: OrchestratorRun): string[] {
  const seen = new Set<string>();
  const ids = [
    ...(Array.isArray(run.agents) ? run.agents : []),
    ...(Array.isArray(run.tasks) ? run.tasks.map((task) => task.agentId) : []),
    ...(Array.isArray(run.results) ? run.results.map((result) => result.agentId) : []),
  ];
  return ids.filter((id) => {
    const key = text(id);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resultForAgent(results: OrchestratorResult[], agentId: string): OrchestratorResult | undefined {
  return [...results].reverse().find((result) => result.agentId === agentId);
}

function taskForAgent(tasks: OrchestratorTask[], agentId: string): OrchestratorTask | undefined {
  return tasks.find((task) => task.agentId === agentId);
}

function agentViews(run: OrchestratorRun, events: TimelineEvent[]): AgentTeamAgentView[] {
  const tasks = Array.isArray(run.tasks) ? run.tasks : [];
  const results = Array.isArray(run.results) ? run.results : [];
  const started = new Set(events.filter((event) => text(event.type) === 'agent_task_started').map((event) => text(event.agentId)).filter(Boolean));
  return uniqueAgentIds(run).map((agentId) => {
    const result = resultForAgent(results, agentId);
    const task = taskForAgent(tasks, agentId);
    const rawStatus = text(result?.status) || (started.has(agentId) ? 'running' : 'idle');
    const warnings = Array.isArray(result?.warnings) ? result.warnings.length : 0;
    const evidence = Array.isArray(result?.evidenceRefs) ? result.evidenceRefs.length : 0;
    return {
      id: agentId,
      label: agentLabel(agentId),
      taskTitle: text(task?.title) || agentLabel(agentId),
      statusLabel: statusLabel(rawStatus),
      tone: resultStatusTone(rawStatus),
      summary: text(result?.summary) || '暂无输出',
      confidence: confidenceText(result?.confidence),
      usage: usageText(result?.usage),
      evidenceCount: evidence,
      warningCount: warnings,
    };
  });
}

function timelineEventsFromRecord(record: RunRecord): TimelineEvent[] {
  return Array.isArray(record.events) ? record.events.map((event) => event as TimelineEvent) : [];
}

export function isOrchestratorRecord(record: Pick<RunRecord, 'type'> | null | undefined): boolean {
  return text(record?.type) === 'orchestrator';
}

export function buildAgentTeamTimelineView(record: RunRecord | null | undefined): AgentTeamTimelineView | null {
  if (!record || !isOrchestratorRecord(record) || !record.orchestratorRun) return null;
  const run = record.orchestratorRun;
  const events = timelineEventsFromRecord(record);
  const agents = agentViews(run, events);
  const results = Array.isArray(run.results) ? run.results : [];
  const evidenceCount = results.reduce((sum, result) => sum + (Array.isArray(result.evidenceRefs) ? result.evidenceRefs.length : 0), 0);
  const warningCount = results.reduce((sum, result) => sum + (Array.isArray(result.warnings) ? result.warnings.length : 0), 0);
  const title = text(run.userGoal) || text(record.input?.prompt) || text(record.promptPreview) || run.runId;
  const mode = [text(run.recipeId), text(run.mode)].filter(Boolean).join(' · ');
  const runStatus = text(run.status || record.status);
  return {
    runId: run.runId,
    title,
    subtitle: [mode, run.runId].filter(Boolean).join(' · '),
    statusLabel: statusLabel(runStatus),
    tone: runStatusTone(runStatus),
    agentCount: agents.length,
    eventCount: events.length,
    evidenceCount,
    warningCount,
    artifactCount: Array.isArray(run.artifacts) ? run.artifacts.length : 0,
    agents,
    events: eventViews(events),
    budgets: budgetViews(latestBudget(events)),
  };
}
