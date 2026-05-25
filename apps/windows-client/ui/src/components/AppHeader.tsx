import type { AuthIdentity } from '../lib/api';
import type { SidePanel } from '../lib/app-types';

interface AppHeaderProps {
  autoApprove: boolean;
  panel: SidePanel;
  planMode: boolean;
  theme: 'light' | 'dark';
  trustedRoot: string;
  user: AuthIdentity;
  onLogout: () => void;
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
  onSetAutoApprove: (value: boolean) => void;
  onSetPlanMode: (value: boolean) => void;
  onTogglePanel: (panel: SidePanel) => void;
  onToggleTheme: () => void;
}

export function AppHeader({
  autoApprove,
  panel,
  planMode,
  theme,
  trustedRoot,
  user,
  onLogout,
  onOpenCommandPalette,
  onOpenSettings,
  onSetAutoApprove,
  onSetPlanMode,
  onTogglePanel,
  onToggleTheme,
}: AppHeaderProps) {
  return (
    <header className="app-header">
      <span className="brand-dot" aria-hidden="true" />
      <h1>Agent Cowork</h1>
      <span className="workspace-path">{trustedRoot}</span>
      <nav className="header-actions">
        <button type="button" onClick={onOpenCommandPalette} title="命令面板 (Ctrl/Cmd+K)">⌘K</button>
        <button type="button" onClick={onToggleTheme} title="深色 / 浅色">{theme === 'dark' ? '☀' : '🌙'}</button>
        <button type="button" className={planMode ? 'is-active' : ''} onClick={() => onSetPlanMode(!planMode)} title="开启后 Kimi 先只读研究并提交计划草案，待你批准后再执行写操作">{planMode ? '计划模式·开' : '计划模式·关'}</button>
        <button type="button" className={autoApprove ? 'is-active' : ''} onClick={() => onSetAutoApprove(!autoApprove)} title="开启后自动批准文件改动；高风险操作（命令/外部连接器）仍需逐次确认">{autoApprove ? '自动批准·开' : '自动批准·关'}</button>
        <button type="button" className={panel === 'tools' ? 'is-active' : ''} onClick={() => onTogglePanel('tools')}>工具</button>
        <button type="button" className={panel === 'viz' ? 'is-active' : ''} onClick={() => onTogglePanel('viz')}>可视化</button>
        <button type="button" className={panel === 'connectors' ? 'is-active' : ''} onClick={() => onTogglePanel('connectors')}>连接器</button>
        <button type="button" className={panel === 'artifacts' ? 'is-active' : ''} onClick={() => onTogglePanel('artifacts')}>产物</button>
        <button type="button" className={panel === 'schedules' ? 'is-active' : ''} onClick={() => onTogglePanel('schedules')}>定时任务</button>
        <button type="button" className={panel === 'memory' ? 'is-active' : ''} onClick={() => onTogglePanel('memory')}>记忆</button>
        <button type="button" className={panel === 'observability' ? 'is-active' : ''} onClick={() => onTogglePanel('observability')}>可观测</button>
        <button type="button" onClick={onOpenSettings} title="API 设置">⚙ 设置</button>
        <span className="header-user" title={`租户 ${user.tenantId}`}>{user.username}</span>
        <button type="button" className="header-logout" onClick={onLogout} title="退出登录">退出</button>
      </nav>
    </header>
  );
}
