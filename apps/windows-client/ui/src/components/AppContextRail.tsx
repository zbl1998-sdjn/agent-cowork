// AppContextRail(UI · 组件层 · components)— 右侧上下文栏,对标 Claude 桌面右栏。
// ---------------------------------------------------------------------------
// 职责:伴随对话常驻右侧,分区显示「运行状态 / Agent Team / 工作文件夹 / 技能·模板」,可收起。
// 仅用 App 已有数据(trustedRoot / recipes / streamingId / mode / model / 轮次 / agentTeamView),不新增网络请求。
import type { AgentMode } from './AppHeader';
import type { Recipe } from './Composer';
import { AgentTeamTimeline } from './AgentTeamTimeline';
import { Icon } from './ui/Icon';
import type { AgentTeamTimelineView } from '../lib/agent-team-timeline';

interface AppContextRailProps {
  trustedRoot: string;
  recipes: Recipe[];
  streamingId: string | null;
  mode: AgentMode;
  model: string;
  messageCount: number;
  agentTeamView?: AgentTeamTimelineView | null | undefined;
  agentTeamLoading?: boolean | undefined;
  agentTeamError?: string | undefined;
  onRefreshAgentTeam?: (() => void) | undefined;
  onOpenRuns?: (() => void) | undefined;
  onPickRecipe: (recipe: Recipe) => void;
  onToggle: () => void;
}

const MODE_LABEL: Record<AgentMode, string> = { plan: '计划', execute: '执行', yolo: 'YOLO' };

export function AppContextRail({ trustedRoot, recipes, streamingId, mode, model, messageCount, agentTeamView = null, agentTeamLoading = false, agentTeamError = '', onRefreshAgentTeam, onOpenRuns, onPickRecipe, onToggle }: AppContextRailProps) {
  const folder = trustedRoot.split(/[\\/]/).filter(Boolean).pop() || trustedRoot;
  return (
    <aside className="context-rail" aria-label="上下文栏">
      <div className="context-head">
        <span className="context-title">上下文</span>
        <button type="button" className="context-collapse" onClick={onToggle} title="收起上下文栏" aria-label="收起上下文栏">
          <Icon name="sidebar" size={15} />
        </button>
      </div>

      <section className="context-card">
        <div className="context-card-head">
          <span>运行状态</span>
          <span className={`context-run-dot${streamingId ? ' is-running' : ''}`} aria-hidden="true" />
        </div>
        <div className="context-run-grid">
          <div><span className="context-k">状态</span><span className="context-v">{streamingId ? '运行中' : '空闲'}</span></div>
          <div><span className="context-k">模式</span><span className="context-v">{MODE_LABEL[mode]}</span></div>
          <div><span className="context-k">模型</span><span className="context-v" title={model}>{model}</span></div>
          <div><span className="context-k">轮次</span><span className="context-v">{messageCount}</span></div>
        </div>
      </section>

      <AgentTeamTimeline view={agentTeamView} loading={agentTeamLoading} error={agentTeamError} onRefresh={onRefreshAgentTeam} onOpenRuns={onOpenRuns} />

      <section className="context-card">
        <div className="context-card-head"><Icon name="projects" size={14} /><span>工作文件夹</span></div>
        <div className="context-folder" title={trustedRoot}>
          <Icon name="projects" size={15} /><span className="context-folder-name">{folder}</span>
        </div>
        <div className="context-folder-path" title={trustedRoot}>{trustedRoot}</div>
      </section>

      <section className="context-card">
        <div className="context-card-head">
          <Icon name="tools" size={14} /><span>技能 · 模板</span><span className="context-count">{recipes.length}</span>
        </div>
        {recipes.length === 0 ? (
          <div className="context-empty">还没有保存的技能 / 模板</div>
        ) : (
          <div className="context-skill-list">
            {recipes.slice(0, 10).map((recipe, index) => (
              <button
                key={recipe.id ?? index}
                type="button"
                className="context-skill"
                title={recipe.name}
                onClick={() => onPickRecipe(recipe)}
              >
                <Icon name="artifacts" size={13} /><span>{recipe.name}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}
