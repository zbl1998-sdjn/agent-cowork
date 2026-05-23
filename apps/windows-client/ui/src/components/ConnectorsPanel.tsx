import { useEffect, useState } from 'react';
import {
  listConnectors,
  suggestConnectors,
  connectConnector,
  type ConnectorInfo,
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
  const [busyId, setBusyId] = useState('');
  const [message, setMessage] = useState('');

  const refresh = async () => {
    try {
      const res = await listConnectors();
      setConnectors(res.connectors);
      setConnected(res.connected || []);
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
          const isOn = connected.includes(c.id) || connected.includes(c.name) || (c.id === 'filesystem' && connected.includes('fs'));
          return (
            <li key={c.id}>
              <code>{c.name}</code>
              {c.builtin && <span className="tool-src">内置</span>}
              <p>{c.description}</p>
              {c.builtin ? (
                <button
                  type="button"
                  disabled={busyId === c.id || isOn}
                  onClick={() => void onConnect(c)}
                >
                  {isOn ? '已连接' : busyId === c.id ? '连接中…' : '一键连接'}
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
