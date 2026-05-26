import { useEffect, useState } from 'react';
import {
  approveOAuthConnector,
  completeOAuthConnector,
  connectConnector,
  disconnectConnector,
  listConnectors,
  revokeOAuthConnector,
  startOAuthConnector,
  suggestConnectors,
  type ConnectorInfo,
  type OAuthStartResult,
} from '../../lib/api';
import { readConnectorOAuthStatus, type OAuthStatusView } from './connectorOAuthStatus';
import { connectorScopeKey, defaultConnectorScopes } from './connectorScopes';

type OAuthApprovalView = { approvalId: string; scopes: string[] };

interface UseConnectorsPanelStateOptions { trustedRoot: string; onConnected?: (servers: string[]) => void; }

export function useConnectorsPanelState({ trustedRoot, onConnected }: UseConnectorsPanelStateOptions) {
  const [query, setQuery] = useState('');
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [connected, setConnected] = useState<string[]>([]);
  const [oauthStatus, setOauthStatus] = useState<Record<string, OAuthStatusView>>({});
  const [oauthSessions, setOauthSessions] = useState<Record<string, OAuthStartResult>>({});
  const [oauthApprovals, setOauthApprovals] = useState<Record<string, OAuthApprovalView>>({});
  const [oauthScopes, setOauthScopes] = useState<Record<string, string[]>>({});
  const [busyId, setBusyId] = useState('');
  const [message, setMessage] = useState('');

  const selectedScopes = (connector: ConnectorInfo) => oauthScopes[connector.id] || defaultConnectorScopes(connector);

  const matchingOAuthApproval = (connector: ConnectorInfo) => {
    const approval = oauthApprovals[connector.id];
    if (!approval) return null;
    return connectorScopeKey(approval.scopes) === connectorScopeKey(selectedScopes(connector)) ? approval : null;
  };

  const refreshOAuthStatus = async (items: ConnectorInfo[]) => {
    setOauthStatus(await readConnectorOAuthStatus(items));
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
      const currentScopes = current[connector.id] || defaultConnectorScopes(connector);
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

  return {
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
  };
}
