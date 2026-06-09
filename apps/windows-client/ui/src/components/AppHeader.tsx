// 顶部栏(UI · 组件层 · components)
// ---------------------------------------------------------------------------
// 职责:渲染品牌标题、工作区切换、运行模式选择、侧栏标签开关、安装包/设置入口与登录身份;仅触发 App 传入的回调。
// 依赖:WorkspaceSwitcher、Button、ICONS;打开安装包目录走 lib/api/transport 的 invokeDesktop。同文件导出 AppHeaderActions。
import type { AuthIdentity } from '../lib/api';
import { invokeDesktop, isDesktop } from '../lib/api/transport';
import type { SidePanel } from '../lib/app-types';
import { ICONS } from '../lib/icons';
import { Button } from './ui/Button';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

// 在 Explorer 中显示最新安装包目录(target/release/bundle/{nsis,msi}/),方便用户取 .exe/.msi。
// 封装在这里后,AppHeaderActions 的点击处理保持一行薄调用。
async function revealInstaller(): Promise<void> {
  if (!isDesktop()) { window.alert('请在桌面端使用'); return; }
  try {
    await invokeDesktop<string>('reveal_bundled_installer');
  } catch (error) {
    window.alert('下载安装包失败:\n' + ((error as Error).message || '未知错误'));
  }
}

export type AgentMode = 'plan' | 'execute' | 'yolo';

const MODE_OPTIONS: Array<{ value: AgentMode; label: string; title: string }> = [
  { value: 'plan', label: '计划', title: '计划模式：先只读研究并提交计划草案，待你批准后再执行写操作' },
  { value: 'execute', label: '执行', title: '执行模式：正常执行，文件改动需逐次批准（推荐）' },
  { value: 'yolo', label: 'YOLO', title: 'YOLO 模式：自动批准一切操作（含高风险命令/连接器），放手跑——请谨慎使用' },
];

interface AppHeaderProps {
  mode: AgentMode;
  panel: SidePanel;
  theme: 'light' | 'dark';
  trustedRoot: string;
  user: AuthIdentity;
  onLogout: () => void;
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
  onSetMode: (value: AgentMode) => void;
  onSwitchWorkspace: (path: string) => void;
  onTogglePanel: (panel: SidePanel) => void;
  onToggleTheme: () => void;
}

type AppHeaderActionsProps = Omit<AppHeaderProps, 'trustedRoot' | 'onSwitchWorkspace'>;

const panelButtons: Array<{ panel: Exclude<SidePanel, 'none'>; label: string }> = [
  { panel: 'tools', label: '工具' },
  { panel: 'viz', label: '可视化' },
  { panel: 'connectors', label: '连接器' },
  { panel: 'artifacts', label: '产物' },
  { panel: 'projects', label: '项目' },
  { panel: 'schedules', label: '定时任务' },
  { panel: 'memory', label: '记忆' },
  { panel: 'observability', label: '可观测' },
];

export function AppHeaderActions({
  mode,
  panel,
  theme,
  user,
  onLogout,
  onOpenCommandPalette,
  onOpenSettings,
  onSetMode,
  onTogglePanel,
  onToggleTheme,
}: AppHeaderActionsProps) {
  return (
    <nav className="header-actions">
      <Button onClick={onOpenCommandPalette} title="命令面板 (Ctrl/Cmd+K)">⌘K</Button>
      <Button onClick={onToggleTheme} title="深色 / 浅色">{theme === 'dark' ? '☀' : '🌙'}</Button>
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
      {panelButtons.map((item) => (
        <Button key={item.panel} className={panel === item.panel ? 'is-active' : ''} onClick={() => onTogglePanel(item.panel)}>
          {item.label}
        </Button>
      ))}
      <Button onClick={() => void revealInstaller()} title="在文件管理器里打开安装包目录(latest .exe / .msi)">{`${ICONS.PACKAGE} 安装包`}</Button>
      <Button onClick={onOpenSettings} title="API 设置">{`${ICONS.SETTINGS} 设置`}</Button>
      <span className="header-user" title={`租户 ${user.tenantId}`}>{user.username}</span>
      <Button className="header-logout" onClick={onLogout} title="退出登录">退出</Button>
    </nav>
  );
}

export function AppHeader({
  mode,
  panel,
  theme,
  trustedRoot,
  user,
  onLogout,
  onOpenCommandPalette,
  onOpenSettings,
  onSetMode,
  onSwitchWorkspace,
  onTogglePanel,
  onToggleTheme,
}: AppHeaderProps) {
  return (
    <header className="app-header">
      <span className="brand-dot" aria-hidden="true" />
      <h1>Agent Cowork</h1>
      <WorkspaceSwitcher current={trustedRoot} onSwitch={onSwitchWorkspace} />
      <AppHeaderActions
        mode={mode}
        panel={panel}
        theme={theme}
        user={user}
        onLogout={onLogout}
        onOpenCommandPalette={onOpenCommandPalette}
        onOpenSettings={onOpenSettings}
        onSetMode={onSetMode}
        onTogglePanel={onTogglePanel}
        onToggleTheme={onToggleTheme}
      />
    </header>
  );
}
