import { useEffect, useState } from 'react';
import {
  listConnectors,
  suggestConnectors,
  connectConnector,
  disconnectConnector,
  startOAuthConnector,
  completeOAuthConnector,
  getOAuthConnectorStatus,
  revokeOAuthConnector,
  type ConnectorInfo,
  type OAuthStartResult,
} from '../lib/api';

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
  const [oauthStatus, setOauthStatus] = useState<Record<string, { connected: boolean; accounts: string[]; configured?: boolean }>>({});
  const [oauthSessions, setOauthSessions] = useState<Record<string, OAuthStartResult>>({});
  const [busyId, setBusyId] = useState('');
  const [message, setMessage] = useState('');

  const refreshOAuthStatus = async (items: ConnectorInfo[]) => {
    const oauthItems = items.filter((connector) => connector.auth?.type === 'oauth-device');
    const next: Record<string, { connected: boolean; accounts: string[]; configured?: boolean }> = {};
    await Promise.all(oauthItems.map(async (connector) => {
      try {
        const status = await getOAuthConnectorStatus(connector.id);
        next[connector.id] = {
          connected: status.connected,
          configured: status.configured,
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
    setBusyId(connector.id);
    setMessage('');
    try {
      const res = await startOAuthConnector({ id: connector.id, scopes: connector.auth?.scopes });
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
      await refreshOAuthStatus(connectors);
      setMessage(`已撤销 ${connector.name}（移除 ${res.removed} 个账户）`);
    } catch (error) {
      setMessage(`撤销失败：${(error as Error).message}`);
    } finally {
      setBusyId('');
    }
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
              {isOAuth ? (
                <button
                  type="button"
                  disabled={busyId === c.id}
                  onClick={() => void (oauth?.connected
                    ? onRevokeOAuth(c)
                    : hasOAuthSession ? onCompleteOAuth(c) : onStartOAuth(c))}
                >
                  {busyId === c.id
                    ? (oauth?.connected ? '撤销中…' : hasOAuthSession ? '确认中…' : '授权中…')
                    : oauth?.connected ? '撤销授权' : hasOAuthSession ? '完成授权' : '开始授权'}
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
