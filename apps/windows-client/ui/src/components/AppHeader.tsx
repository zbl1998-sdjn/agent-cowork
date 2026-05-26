import type { AuthIdentity } from '../lib/api';
import type { SidePanel } from '../lib/app-types';
import { Button } from './ui/Button';

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

type AppHeaderActionsProps = Omit<AppHeaderProps, 'trustedRoot'>;

const panelButtons: Array<{ panel: Exclude<SidePanel, 'none'>; label: string }> = [
  { panel: 'tools', label: '工具' },
  { panel: 'viz', label: '可视化' },
  { panel: 'connectors', label: '连接器' },
  { panel: 'artifacts', label: '产物' },
  { panel: 'schedules', label: '定时任务' },
  { panel: 'memory', label: '记忆' },
  { panel: 'observability', label: '可观测' },
];

export function AppHeaderActions({
  autoApprove,
  panel,
  planMode,
  theme,
  user,
  onLogout,
  onOpenCommandPalette,
  onOpenSettings,
  onSetAutoApprove,
  onSetPlanMode,
  onTogglePanel,
  onToggleTheme,
}: AppHeaderActionsProps) {
  return (
    <nav className="header-actions">
      <Button onClick={onOpenCommandPalette} title="命令面板 (Ctrl/Cmd+K)">⌘K</Button>
      <Button onClick={onToggleTheme} title="深色 / 浅色">{theme === 'dark' ? '☀' : '🌙'}</Button>
      <Button className={planMode ? 'is-active' : ''} onClick={() => onSetPlanMode(!planMode)} title="开启后 Kimi 先只读研究并提交计划草案，待你批准后再执行写操作">{planMode ? '计划模式·开' : '计划模式·关'}</Button>
      <Button className={autoApprove ? 'is-active' : ''} onClick={() => onSetAutoApprove(!autoApprove)} title="开启后自动批准文件改动；高风险操作（命令/外部连接器）仍需逐次确认">{autoApprove ? '自动批准·开' : '自动批准·关'}</Button>
      {panelButtons.map((item) => (
        <Button key={item.panel} className={panel === item.panel ? 'is-active' : ''} onClick={() => onTogglePanel(item.panel)}>
          {item.label}
        </Button>
      ))}
      <Button onClick={onOpenSettings} title="API 设置">⚙ 设置</Button>
      <span className="header-user" title={`租户 ${user.tenantId}`}>{user.username}</span>
      <Button className="header-logout" onClick={onLogout} title="退出登录">退出</Button>
    </nav>
  );
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
      <AppHeaderActions
        autoApprove={autoApprove}
        panel={panel}
        planMode={planMode}
        theme={theme}
        user={user}
        onLogout={onLogout}
        onOpenCommandPalette={onOpenCommandPalette}
        onOpenSettings={onOpenSettings}
        onSetAutoApprove={onSetAutoApprove}
        onSetPlanMode={onSetPlanMode}
        onTogglePanel={onTogglePanel}
        onToggleTheme={onToggleTheme}
      />
    </header>
  );
}
