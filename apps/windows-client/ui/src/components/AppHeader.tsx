// 顶部栏(UI · 组件层 · components)— 对标 Claude 的极简顶栏。
// 品牌与面板入口已下沉到左侧导航栏(ConversationRail);顶栏只留:工作区切换、运行模式、命令面板、更多(外观/安装包/退出)。
// 仅触发 App 传入的回调。同文件导出 AppHeaderActions。
import type { AuthIdentity } from '../lib/api';
import { invokeDesktop, isDesktop } from '../lib/api/transport';
import type { AgentMode } from '../lib/types';
import { Icon } from './ui/Icon';
import { Button } from './ui/Button';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

// 在 Explorer 中显示最新安装包目录,方便用户取 .exe/.msi。
async function revealInstaller(): Promise<void> {
  if (!isDesktop()) { window.alert('请在桌面端使用'); return; }
  try {
    await invokeDesktop<string>('reveal_bundled_installer');
  } catch (error) {
    window.alert('下载安装包失败:\n' + ((error as Error).message || '未知错误'));
  }
}

const MODE_OPTIONS: Array<{ value: AgentMode; label: string; title: string }> = [
  { value: 'plan', label: '计划', title: '计划模式:先只读研究并提交计划草案,待你批准后再执行写操作' },
  { value: 'execute', label: '执行', title: '执行模式:正常执行,文件改动需逐次批准(推荐)' },
  { value: 'auto', label: '安全自动', title: '安全自动:低风险操作可自动执行;高风险操作仍需你批准' },
];

interface AppHeaderProps {
  mode: AgentMode;
  theme: 'light' | 'dark';
  trustedRoot: string;
  user: AuthIdentity;
  sidebarCollapsed: boolean;
  onLogout: () => void;
  onOpenCommandPalette: () => void;
  onSetMode: (value: AgentMode) => void;
  onSwitchWorkspace: (path: string) => void;
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
}

type AppHeaderActionsProps = Omit<AppHeaderProps, 'trustedRoot' | 'onSwitchWorkspace' | 'sidebarCollapsed' | 'onToggleSidebar'>;

export function AppHeaderActions({
  mode, theme, user, onLogout, onOpenCommandPalette, onSetMode, onToggleTheme,
}: AppHeaderActionsProps) {
  return (
    <nav className="header-actions">
      <select
        className="mode-select"
        value={mode}
        onChange={(e) => onSetMode(e.target.value as AgentMode)}
        title={MODE_OPTIONS.find((o) => o.value === mode)?.title}
        aria-label="运行模式"
      >
        {MODE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>模式·{opt.label}</option>
        ))}
      </select>
      <Button className="header-cmdk" onClick={onOpenCommandPalette} title="命令面板 (Ctrl/Cmd+K)">
        <Icon name="command" size={15} /><span>K</span>
      </Button>
      <details className="header-more">
        <summary className="header-more-summary" title="更多"><Icon name="more" size={17} /></summary>
        <div className="header-more-menu">
          <Button className="header-more-item" onClick={onToggleTheme} title="深色 / 浅色">
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} /><span>外观</span>
          </Button>
          <Button className="header-more-item" onClick={() => void revealInstaller()} title="在文件管理器里打开安装包目录">
            <Icon name="package" size={15} /><span>安装包</span>
          </Button>
          <Button className="header-more-item header-logout" onClick={onLogout} title="退出登录">退出</Button>
          <div className="header-more-user" title={`租户 ${user.tenantId}`}>{user.username}</div>
        </div>
      </details>
    </nav>
  );
}

export function AppHeader({
  mode, theme, trustedRoot, user, sidebarCollapsed, onLogout, onOpenCommandPalette, onSetMode, onSwitchWorkspace, onToggleTheme, onToggleSidebar,
}: AppHeaderProps) {
  return (
    <header className="app-header">
      <button
        type="button"
        className="header-sidebar-toggle"
        onClick={onToggleSidebar}
        title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
        aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
      >
        <Icon name="sidebar" size={17} />
      </button>
      <div className="header-workspace">
        <WorkspaceSwitcher current={trustedRoot} onSwitch={onSwitchWorkspace} />
      </div>
      <div className="header-flex-spacer" />
      <AppHeaderActions
        mode={mode}
        theme={theme}
        user={user}
        onLogout={onLogout}
        onOpenCommandPalette={onOpenCommandPalette}
        onSetMode={onSetMode}
        onToggleTheme={onToggleTheme}
      />
    </header>
  );
}
