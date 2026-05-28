import { Empty, ErrorState } from '../ui/StateViews';
import { ConnectorBuiltinAction, ConnectorOAuthAction, ConnectorSearchAction } from './ConnectorActions';
import { connectorPermissions } from './connectorScopes';
import { useConnectorsPanelState } from './useConnectorsPanelState';

interface ConnectorsPanelProps {
  trustedRoot: string;
  onConnected?: (servers: string[]) => void;
}

const CONNECTOR_ERROR_PREFIXES = [
  '错误：',
  '部分失败：',
  '连接失败：',
  '断开失败：',
  '授权失败：',
  '审批失败：',
  '授权确认失败：',
  '撤销失败：',
];

export function isConnectorErrorMessage(message: string): boolean {
  return CONNECTOR_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix));
}

export function ConnectorsPanelEmptyState() {
  return <Empty title="没有匹配的连接器" message="调整关键词或刷新连接器目录。" />;
}

export function ConnectorsPanelMessageState({ message }: { message: string }) {
  if (!message) return null;
  if (isConnectorErrorMessage(message)) {
    const detail = CONNECTOR_ERROR_PREFIXES.reduce(
      (current, prefix) => current.replace(new RegExp(`^${prefix}`), ''),
      message,
    );
    return <ErrorState title="连接器操作失败" message={detail} />;
  }
  return <pre className="panel-result">{message}</pre>;
}

export { ConnectorBuiltinAction, ConnectorOAuthAction, ConnectorSearchAction } from './ConnectorActions';

// Connector catalog + one-click MCP connect. Mirrors Claude Cowork's "suggest
// connectors": browse the curated catalog, search by keyword, and connect a
// builtin (e.g. filesystem) with one click. Non-builtin connectors show their
// install command for the user to run.
export function ConnectorsPanel({ trustedRoot, onConnected }: ConnectorsPanelProps) {
  const {
    query,
    setQuery,
    connectors,
    connected,
    oauthStatus,
    oauthSessions,
    busyId,
    message,
    selectedScopes,
    matchingOAuthApproval,
    onSearch,
    onConnect,
    onDisconnect,
    onStartOAuth,
    onApproveOAuth,
    onCompleteOAuth,
    onRevokeOAuth,
    onToggleOAuthScope,
  } = useConnectorsPanelState({ trustedRoot, onConnected });

  return (
    <section className="side-panel">
      <h2>连接外部工具</h2>
      <p className="panel-intro">连上以后,Kimi 就能帮你操作:Notion 文档、Gmail 邮件、GitHub 代码、自家数据库等等。点「连接」按钮授权一次,之后在对话里直接说「发个邮件」「记到 Notion」就行。</p>
      <div className="panel-row">
        <input
          value={query}
          placeholder="搜一搜要连什么(如 邮件 / 文档 / 数据库)"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void onSearch(); }}
        />
        <ConnectorSearchAction onSearch={() => void onSearch()} />
      </div>

      {connected.length > 0 && (
        <div className="connector-connected">
          <label>已连接</label>
          <div className="connector-chips">
            {connected.map((name) => <span key={name} className="attachment-chip">{name}</span>)}
          </div>
        </div>
      )}

      <ul className="tool-list">
        {connectors.map((c) => {
          const oauth = oauthStatus[c.id];
          const isOAuth = c.auth?.type === 'oauth-device';
          const hasOAuthSession = Boolean(oauthSessions[c.id]);
          const missingOAuthConfig = Boolean(isOAuth && oauth?.configured === false && !oauth?.connected);
          const approved = matchingOAuthApproval(c);
          const scopes = selectedScopes(c);
          const isOn = connected.includes(c.id)
            || connected.includes(c.name)
            || (c.id === 'filesystem' && connected.includes('fs'))
            || Boolean(oauth?.connected);
          return (
            <li key={c.id}>
              <code>{c.name}</code>
              {c.builtin && <span className="tool-src">内置</span>}
              {isOAuth && <span className="tool-src">OAuth</span>}
              {isOn && <span className="tool-src">已连接</span>}
              <p>{c.description}</p>
              {missingOAuthConfig && (
                <div className="connector-oauth-warning" role="status">
                  {oauth?.configurationMessage || `需要先配置 ${oauth?.requiredEnv?.[0] || 'OAuth client id'}。`}
                </div>
              )}
              {isOAuth && !oauth?.connected && (
                <div className="connector-permissions">
                  {connectorPermissions(c).map((permission) => (
                    <label key={permission.id}>
                      <input
                        type="checkbox"
                        checked={scopes.includes(permission.id)}
                        disabled={busyId === c.id || hasOAuthSession}
                        onChange={(event) => onToggleOAuthScope(c, permission.id, event.currentTarget.checked)}
                      />
                      <span>{permission.label}</span>
                      {permission.risk === 'high' && <em>高风险</em>}
                    </label>
                  ))}
                </div>
              )}
              {isOAuth ? (
                <ConnectorOAuthAction
                  busy={busyId === c.id}
                  connected={Boolean(oauth?.connected)}
                  hasSession={hasOAuthSession}
                  approved={Boolean(approved)}
                  missingConfig={missingOAuthConfig}
                  onApprove={() => void onApproveOAuth(c)}
                  onStart={() => void onStartOAuth(c)}
                  onComplete={() => void onCompleteOAuth(c)}
                  onRevoke={() => void onRevokeOAuth(c)}
                />
              ) : c.builtin ? (
                <ConnectorBuiltinAction
                  busy={busyId === c.id}
                  connected={isOn}
                  onConnect={() => void onConnect(c)}
                  onDisconnect={() => void onDisconnect(c)}
                />
              ) : (
                <code className="connector-install">{c.install}</code>
              )}
            </li>
          );
        })}
        {connectors.length === 0 && (
          <li className="panel-empty">
            <ConnectorsPanelEmptyState />
          </li>
        )}
      </ul>

      <ConnectorsPanelMessageState message={message} />
    </section>
  );
}
