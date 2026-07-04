// ConversationRail(UI · components):左侧会话栏——列出历史会话、切换/新建/改名/删除,显示当前选中。纯展示+回调。
// 样式全在 styles.css(.conversation-rail / .conv-item / .conv-title / .conv-actions);组件不内联 style,避免覆盖收敛层。
import type { Conversation } from '../lib/app-types';
import { conversationBranchOptions } from '../lib/conversation-branches';
import { ICONS } from '../lib/icons';
import { Button, IconButton } from './ui/Button';

interface ConversationRailProps {
  activeConvId: string;
  convSearch: string;
  conversations: Conversation[];
  renamingId: string | null;
  renameText: string;
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
}

export function ConversationRail({
  activeConvId,
  convSearch,
  conversations,
  renamingId,
  renameText,
  onCommitRename,
  onDelete,
  onExport,
  onNew,
  onRenameText,
  onSearch,
  onSetRenamingId,
  onSwitchBranch,
  onSwitch,
  onTogglePin,
}: ConversationRailProps) {
  return (
    <aside className="conversation-rail">
      <div className="rail-head">
        <span className="rail-title">对话</span>
        <span className="rail-count">{conversations.length}</span>
      </div>
      <Button className="new-conv-btn" onClick={onNew}>＋ 新建对话</Button>
      <input
        className="conv-search"
        aria-label="搜索对话"
        placeholder="搜索对话…"
        value={convSearch}
        onChange={(e) => onSearch(e.target.value)}
      />
      <div className="conv-list">
        {conversations.map((c) => (
          <div key={c.id} className={`conv-item${c.id === activeConvId ? ' is-active' : ''}${c.pinned ? ' is-pinned' : ''}`}>
            {renamingId === c.id ? (
              <input
                className="conv-rename"
                autoFocus
                value={renameText}
                onChange={(e) => onRenameText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onCommitRename();
                  else if (e.key === 'Escape') onSetRenamingId(null);
                }}
                onBlur={onCommitRename}
              />
            ) : (
              <>
                <Button variant="ghost" className="conv-title" onClick={() => onSwitch(c.id)}>{c.pinned ? `${ICONS.PIN} ` : ''}{c.title || '新对话'}</Button>
                <div className="conv-actions">
                  <IconButton className="conv-act" label={c.pinned ? '取消置顶' : '置顶'} onClick={() => onTogglePin(c.id)}>{c.pinned ? '☆' : '⤒'}</IconButton>
                  <IconButton className="conv-act" label="导出 Markdown" onClick={() => onExport(c.id)}>⤓</IconButton>
                  <IconButton
                    className="conv-act"
                    label="重命名"
                    onClick={() => {
                      onSetRenamingId(c.id);
                      onRenameText(c.title || '');
                    }}
                  >
                    ✎
                  </IconButton>
                  <IconButton className="conv-act" label="删除" onClick={() => onDelete(c.id)}>✕</IconButton>
                </div>
                {(() => {
                  const branchOptions = conversationBranchOptions(c);
                  const activeBranch = branchOptions.find((branch) => branch.id === (c.activeBranchId || 'main')) || branchOptions[0];
                  if (branchOptions.length <= 1) return null;
                  if (!activeBranch) return null;
                  return (
                    <div className="conv-branch-row">
                      <select
                        className="conv-branch-select"
                        value={activeBranch.id}
                        title={activeBranch.description || '切换对话分支'}
                        aria-label="切换对话分支"
                        onChange={(e) => onSwitchBranch(c.id, e.target.value)}
                      >
                        {branchOptions.map((branch) => (
                          <option key={branch.id} value={branch.id}>{branch.label}</option>
                        ))}
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
