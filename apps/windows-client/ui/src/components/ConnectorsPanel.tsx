import { useEffect, useState } from 'react';
import {
  listConnectors,
  suggestConnectors,
  connectConnector,
  disconnectConnector,
  approveOAuthConnector,
  startOAuthConnector,
  completeOAuthConnector,
  getOAuthConnectorStatus,
  revokeOAuthConnector,
  type ConnectorInfo,
  type OAuthPermission,
  type OAuthStartResult,
} from '../lib/api';

type OAuthStatusView = {
  connected: boolean;
  accounts: string[];
  configured?: boolean;
  configurationMessage?: string;
  requiredEnv?: string[];
};

interface ConnectorsPanelProps {
  trustedRoot: string;
  onConnected?: (servers: string[]) => void;
}

// Connector catalog + one-click MCP connect. Mirrors Claude Cowork's "suggest
// connectors": browse the curated catalog, search by keyword, and connect a
// builtin (e.g. filesystem) with one click. Non-builtin connectors show their
// install command for the user to run.
export function ConnectorsPanel({ trustedRoot, onConnected }: ConnectorsPanelProps) {
  const [query, setQuery] = useState('');
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [connected, setConnected] = useState<string[]>([]);
  const [oauthStatus, setOauthStatus] = useState<Record<string, OAuthStatusView>>({});
  const [oauthSessions, setOauthSessions] = useState<Record<string, OAuthStartResult>>({});
  const [oauthApprovals, setOauthApprovals] = useState<Record<string, { approvalId: string; scopes: string[] }>>({});
  const [oauthScopes, setOauthScopes] = useState<Record<string, string[]>>({});
  const [busyId, setBusyId] = useState('');
  const [message, setMessage] = useState('');

  const connectorPermissions = (connector: ConnectorInfo): OAuthPermission[] => (
    connector.auth?.permissions || (connector.auth?.scopes || []).map((scope) => ({
      id: scope,
      label: scope,
      risk: 'low',
      default: true,
    }))
  );

  const defaultScopes = (connector: ConnectorInfo) => {
    const defaults = connectorPermissions(connector)
      .filter((permission) => permission.default !== false)
      .map((permission) => permission.id);
    return defaults.length ? defaults : connector.auth?.scopes || [];
  };

  const selectedScopes = (connector: ConnectorInfo) => oauthScopes[connector.id] || defaultScopes(connector);
  const scopeKey = (scopes: string[]) => [...scopes].sort().join('\n');
  const matchingOAuthApproval = (connector: ConnectorInfo) => {
    const approval = oauthApprovals[connector.id];
    if (!approval) return null;
    return scopeKey(approval.scopes) === scopeKey(selectedScopes(connector)) ? approval : null;
  };

  const refreshOAuthStatus = async (items: ConnectorInfo[]) => {
    const oauthItems = items.filter((connector) => connector.auth?.type === 'oauth-device');
    const next: Record<string, OAuthStatusView> = {};
    await Promise.all(oauthItems.map(async (connector) => {
      try {
        const status = await getOAuthConnectorStatus(connector.id);
        next[connector.id] = {
          connected: status.connected,
          configured: status.configured,
          configurationMessage: status.configurationMessage,
          requiredEnv: status.requiredEnv,
          accounts: (status.accounts || []).map((account) => account.accountId),
        };
      } catch {
        next[connector.id] = { connected: false, accounts: [] };
      }
    }));
    setOauthStatus(next);
  };

  const refresh = async () => {
    try {
      const res = await listConnectors();
      setConnectors(res.connectors);
      setConnected(res.connected || []);
      await refreshOAuthStatus(res.connectors);
    } catch (error) {
      setMessage(`错误：${(error as Error).message}`);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const onSearch = async () => {
    setMessage('');
    try {
      if (!query.trim()) { await refresh(); return; }
      setConnectors(await suggestConnectors(query, 8));
    } catch (error) {
      setMessage(`错误：${(error as Error).message}`);
    }
  };

  const onConnect = async (connector: ConnectorInfo) => {
    setBusyId(connector.id);
    setMessage('');
    try {
      const res = await connectConnector({ id: connector.id, trustedRoot });
      setConnected(res.mcpServers || []);
      const errs = (res.errors || []).filter((e) => e && e.error);
      setMessage(errs.length
        ? `部分失败：${errs.map((e) => e.error).join('；')}`
        : `已连接 ${connector.name}（新增 ${res.connected} 个工具）`);
      onConnected?.(res.mcpServers || []);
    } catch (error) {
      setMessage(`连接失败：${(error as Error).message}`);
    } finally {
      setBusyId('');
    }
  };

  const onDisconnect = async (connector: ConnectorInfo) => {
    setBusyId(connector.id);
    setMessage('');
    try {
      const res = await disconnectConnector({ id: connector.id });
      setConnected(res.mcpServers || []);
      setMessage(res.removed
        ? `已断开 ${connector.name}（移除 ${res.toolsRemoved} 个工具）`
        : `${connector.name} 当前未连接`);
      onConnected?.(res.mcpServers || []);
    } catch (error) {
      setMessage(`断开失败：${(error as Error).message}`);
    } finally {
      setBusyId('');
    }
  };

  const onStartOAuth = async (connector: ConnectorInfo) => {
    const approval = matchingOAuthApproval(connector);
    if (!approval) {
      setMessage(`请先审批 ${connector.name} 权限`);
      return;
    }
    setBusyId(connector.id);
    setMessage('');
    try {
      const scopes = selectedScopes(connector);
      const res = await startOAuthConnector({ id: connector.id, scopes, approvalId: approval.approvalId });
      setOauthSessions((current) => ({ ...current, [connector.id]: res }));
      if (typeof window !== 'undefined' && typeof window.open === 'function') {
        window.open(res.verificationUri, '_blank', 'noopener,noreferrer');
      }
      setMessage(`打开 ${res.verificationUri}，输入 ${res.userCode} 后点击完成授权`);
    } catch (error) {
      setMessage(`授权失败：${(error as Error).message}`);
    } finally {
      setBusyId('');
    }
  };

  const onApproveOAuth = async (connector: ConnectorInfo) => {
    const scopes = selectedScopes(connector);
    if (scopes.length === 0) {
      setMessage(`请选择 ${connector.name} 权限`);
      return;
    }
    setBusyId(connector.id);
    setMessage('');
    try {
      const res = await approveOAuthConnector({ id: connector.id, scopes });
      setOauthApprovals((current) => ({
        ...current,
        [connector.id]: { approvalId: res.approvalId, scopes: res.scopes },
      }));
      setMessage(`已审批 ${connector.name} 权限：${res.scopes.join('、')}`);
    } catch (error) {
      setMessage(`审批失败：${(error as Error).message}`);
    } finally {
      setBusyId('');
    }
  };

  const onCompleteOAuth = async (connector: ConnectorInfo) => {
    const session = oauthSessions[connector.id];
    if (!session) {
      await onStartOAuth(connector);
      return;
    }
    setBusyId(connector.id);
    setMessage('');
    try {
      const res = await completeOAuthConnector({ id: connector.id, sessionId: session.sessionId });
      if (res.status === 'pending') {
        setMessage(`${connector.name} 仍在等待授权确认`);
        return;
      }
      setOauthSessions((current) => {
        const next = { ...current };
        delete next[connector.id];
        return next;
      });
      setOauthApprovals((current) => {
        const next = { ...current };
        delete next[connector.id];
        return next;
      });
      await refreshOAuthStatus(connectors);
      const login = res.account?.login || res.credential?.accountId || connector.name;
      setMessage(`已授权 ${connector.name}：${login}`);
    } catch (error) {
      setMessage(`授权确认失败：${(error as Error).message}`);
    } finally {
      setBusyId('');
    }
  };

  const onRevokeOAuth = async (connector: ConnectorInfo) => {
    setBusyId(connector.id);
    setMessage('');
    try {
      const res = await revokeOAuthConnector({ id: connector.id });
      setOauthSessions((current) => {
        const next = { ...current };
        delete next[connector.id];
        return next;
      });
      setOauthApprovals((current) => {
        const next = { ...current };
        delete next[connector.id];
        return next;
      });
      await refreshOAuthStatus(connectors);
      setMessage(`已撤销 ${connector.name}（移除 ${res.removed} 个账户）`);
    } catch (error) {
      setMessage(`撤销失败：${(error as Error).message}`);
    } finally {
      setBusyId('');
    }
  };

  const onToggleOAuthScope = (connector: ConnectorInfo, scope: string, enabled: boolean) => {
    setOauthScopes((current) => {
      const currentScopes = current[connector.id] || defaultScopes(connector);
      const nextScopes = enabled
        ? [...new Set([...currentScopes, scope])]
        : currentScopes.filter((item) => item !== scope);
      return { ...current, [connector.id]: nextScopes };
    });
    setOauthApprovals((current) => {
      const next = { ...current };
      delete next[connector.id];
      return next;
    });
  };

  return (
    <section className="side-panel">
      <h2>连接器</h2>
      <div className="panel-row">
        <input
          value={query}
          placeholder="搜索连接器（如 数据库 / git）"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void onSearch(); }}
        />
        <button type="button" onClick={() => void onSearch()}>搜索</button>
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
                <button
                  type="button"
                  disabled={busyId === c.id || missingOAuthConfig}
                  onClick={() => void (oauth?.connected
                    ? onRevokeOAuth(c)
                    : hasOAuthSession ? onCompleteOAuth(c) : approved ? onStartOAuth(c) : onApproveOAuth(c))}
                >
                  {busyId === c.id
                    ? (oauth?.connected ? '撤销中…' : hasOAuthSession ? '确认中…' : approved ? '授权中…' : '审批中…')
                    : oauth?.connected ? '撤销授权' : missingOAuthConfig ? '待配置 OAuth' : hasOAuthSession ? '完成授权' : approved ? '开始授权' : '审批权限'}
                </button>
              ) : c.builtin ? (
                <button
                  type="button"
                  disabled={busyId === c.id}
                  onClick={() => void (isOn ? onDisconnect(c) : onConnect(c))}
                >
                  {busyId === c.id ? (isOn ? '断开中…' : '连接中…') : isOn ? '断开' : '一键连接'}
                </button>
              ) : (
                <code className="connector-install">{c.install}</code>
              )}
            </li>
          );
        })}
        {connectors.length === 0 && <li className="panel-empty">没有匹配的连接器</li>}
      </ul>

      {message && <pre className="panel-result">{message}</pre>}
    </section>
  );
}
