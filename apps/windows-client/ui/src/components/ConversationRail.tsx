// ConversationRail(UI · components):左侧栏——对标 Claude 桌面的「导航中心」。
// 品牌 → 新建对话 → 面板导航(任务/工具/连接器/产物/记忆/可观测/定时/项目/可视化)→ 搜索 → 最近对话。
// 对齐 Claude:侧栏底部保持极简(设置/主题/安全下沉到顶栏「更多」与命令面板,不再放侧栏 footer)。
import type { Conversation, SidePanel } from '../lib/app-types';
import { conversationBranchOptions } from '../lib/conversation-branches';
import { Icon, type IconName } from './ui/Icon';

type PanelId = Exclude<SidePanel, 'none'>;

const NAV_ITEMS: Array<{ id: PanelId; icon: IconName; label: string }> = [
  { id: 'tasks', icon: 'history', label: '任务' },
  { id: 'tools', icon: 'tools', label: '工具' },
  { id: 'connectors', icon: 'connectors', label: '连接器' },
  { id: 'artifacts', icon: 'artifacts', label: '产物' },
  { id: 'memory', icon: 'memory', label: '记忆' },
  { id: 'observability', icon: 'observability', label: '成本 · 可观测' },
  { id: 'schedules', icon: 'schedules', label: '定时任务' },
  { id: 'projects', icon: 'projects', label: '项目' },
  { id: 'viz', icon: 'viz', label: '可视化' },
];

interface ConversationRailProps {
  activeConvId: string;
  convSearch: string;
  conversations: Conversation[];
  renamingId: string | null;
  renameText: string;
  panel: SidePanel;
  onCommitRename: () => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  onNew: () => void;
  onRenameText: (text: string) => void;
  onSearch: (text: string) => void;
  onSetRenamingId: (id: string | null) => void;
  onSwitchBranch: (conversationId: string, branchId: string) => void;
  onSwitch: (id: string) => void;
  onTogglePin: (id: string) => void;
  onNavigate: (panel: PanelId) => void;
}

export function ConversationRail({
  activeConvId, convSearch, conversations, renamingId, renameText, panel,
  onCommitRename, onDelete, onExport, onNew, onRenameText, onSearch,
  onSetRenamingId, onSwitchBranch, onSwitch, onTogglePin, onNavigate,
}: ConversationRailProps) {
  return (
    <aside className="conversation-rail">
      <div className="rail-brand">
        <span className="rail-brand-mark" aria-hidden="true"><Icon name="sparkle" size={16} /></span>
        <span className="rail-brand-name">Agent Cowork</span>
        <span className="rail-release-badge" title="Internal beta build; suitable for small-circle testing">Beta</span>
      </div>

      <button type="button" className="rail-new" onClick={onNew}>
        <Icon name="new-chat" size={16} /><span>新建对话</span>
      </button>

      <nav className="rail-nav" aria-label="功能面板">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`rail-nav-item${panel === item.id ? ' is-active' : ''}`}
            aria-pressed={panel === item.id}
            onClick={() => onNavigate(item.id)}
          >
            <Icon name={item.icon} size={17} /><span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="rail-search">
        <Icon name="search" size={15} />
        <input aria-label="搜索对话" placeholder="搜索对话…" value={convSearch} onChange={(e) => onSearch(e.target.value)} />
      </div>

      <div className="rail-recents-head">最近</div>
      <div className="conv-list">
        {conversations.map((c) => (
          <div key={c.id} className={`conv-item${c.id === activeConvId ? ' is-active' : ''}${c.pinned ? ' is-pinned' : ''}`}>
            {renamingId === c.id ? (
              <input
                className="conv-rename" autoFocus value={renameText}
                onChange={(e) => onRenameText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') onCommitRename(); else if (e.key === 'Escape') onSetRenamingId(null); }}
                onBlur={onCommitRename}
              />
            ) : (
              <>
                <button type="button" className="conv-title" onClick={() => onSwitch(c.id)}>
                  {c.pinned && <Icon name="pin" size={13} />}{c.title || '新对话'}
                </button>
                <div className="conv-actions">
                  <button type="button" className="conv-act" aria-label={c.pinned ? '取消置顶' : '置顶'} title={c.pinned ? '取消置顶' : '置顶'} onClick={() => onTogglePin(c.id)}><Icon name="pin" size={14} /></button>
                  <button type="button" className="conv-act" aria-label="导出 Markdown" title="导出 Markdown" onClick={() => onExport(c.id)}><Icon name="export" size={14} /></button>
                  <button type="button" className="conv-act" aria-label="重命名" title="重命名" onClick={() => { onSetRenamingId(c.id); onRenameText(c.title || ''); }}><Icon name="rename" size={14} /></button>
                  <button type="button" className="conv-act" aria-label="删除" title="删除" onClick={() => onDelete(c.id)}><Icon name="trash" size={14} /></button>
                </div>
                {(() => {
                  const branchOptions = conversationBranchOptions(c);
                  const activeBranch = branchOptions.find((b) => b.id === (c.activeBranchId || 'main')) || branchOptions[0];
                  if (branchOptions.length <= 1 || !activeBranch) return null;
                  return (
                    <div className="conv-branch-row">
                      <select className="conv-branch-select" value={activeBranch.id} title={activeBranch.description || '切换对话分支'} aria-label="切换对话分支" onChange={(e) => onSwitchBranch(c.id, e.target.value)}>
                        {branchOptions.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
                      </select>
                      <span className="conv-branch-meta" title={activeBranch.description}>{activeBranch.description}</span>
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        ))}
        {conversations.length === 0 && <div className="conv-empty">没有匹配的对话</div>}
      </div>
    </aside>
  );
}
