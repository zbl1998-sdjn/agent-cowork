import { useEffect, useState } from 'react';
import {
  forgetMemoryProfile,
  getMemoryProfile,
  learnMemoryProfile,
  type MemoryProfileEntry,
  type MemoryProfileType,
} from '../../lib/api';
import { Empty, ErrorState } from '../ui/StateViews';

interface MemoryPanelProps {
  trustedRoot: string;
}

const TYPE_LABEL: Record<MemoryProfileType, string> = {
  term: '术语',
  project: '项目',
  preference: '偏好',
};

export function formatProfileEntry(entry: MemoryProfileEntry): string {
  return `${TYPE_LABEL[entry.type] || entry.type} · ${entry.key}: ${entry.value}`;
}

export function MemoryPanelStateViews({ error, onRetry }: { error: string; onRetry: () => void }) {
  if (error) {
    return <ErrorState title="记忆加载失败" message={error} onRetry={onRetry} retryLabel="重新加载" />;
  }
  return <Empty title="暂无本地画像记忆" message="保存术语、项目和偏好后会显示在这里。" />;
}

export function MemoryPanel({ trustedRoot }: MemoryPanelProps) {
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<MemoryProfileEntry[]>([]);
  const [type, setType] = useState<MemoryProfileType>('term');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [evidence, setEvidence] = useState('用户显式确认');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setBusy(true); setError('');
    try {
      const res = await getMemoryProfile(trustedRoot, query);
      setEntries(res.profile.entries || []);
    } catch (err) {
      setError((err as Error).message || '记忆读取失败');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trustedRoot]);

  const learn = async () => {
    if (!key.trim() || !value.trim()) return;
    setBusy(true); setError('');
    try {
      const res = await learnMemoryProfile({ type, key: key.trim(), value: value.trim(), evidence: evidence.trim() || '用户显式确认' }, trustedRoot);
      setEntries(res.profile.entries || []);
      setKey('');
      setValue('');
    } catch (err) {
      setError((err as Error).message || '记忆保存失败');
    } finally {
      setBusy(false);
    }
  };

  const forget = async (entry: MemoryProfileEntry) => {
    setBusy(true); setError('');
    try {
      const res = await forgetMemoryProfile({ type: entry.type, key: entry.key }, trustedRoot);
      setEntries(res.profile.entries || []);
    } catch (err) {
      setError((err as Error).message || '记忆删除失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="side-panel">
      <h2>记忆</h2>
      <div className="panel-row">
        <input
          value={query}
          placeholder="按当前任务召回"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void load(); }}
        />
        <button type="button" disabled={busy} onClick={() => void load()}>{busy ? '读取中…' : '刷新'}</button>
      </div>
      {error && <MemoryPanelStateViews error={error} onRetry={() => void load()} />}
      <ul className="tool-list">
        {entries.map((entry) => (
          <li key={`${entry.type}:${entry.key}`}>
            <code>{formatProfileEntry(entry)}</code>
            <span className="tool-src">{entry.scope || 'user'}</span>
            <p>{entry.evidence}</p>
            <button type="button" disabled={busy} onClick={() => void forget(entry)}>删除</button>
          </li>
        ))}
        {entries.length === 0 && !error && (
          <li className="panel-empty">
            <MemoryPanelStateViews error="" onRetry={() => void load()} />
          </li>
        )}
      </ul>
      <div className="panel-call">
        <label>新增记忆</label>
        <div className="panel-row">
          <select className="model-select" value={type} onChange={(event) => setType(event.target.value as MemoryProfileType)}>
            <option value="term">术语</option>
            <option value="project">项目</option>
            <option value="preference">偏好</option>
          </select>
          <input value={key} placeholder="键" onChange={(event) => setKey(event.target.value)} />
        </div>
        <textarea value={value} rows={2} placeholder="值" onChange={(event) => setValue(event.target.value)} />
        <textarea value={evidence} rows={2} placeholder="依据" onChange={(event) => setEvidence(event.target.value)} />
        <button type="button" disabled={busy || !key.trim() || !value.trim()} onClick={() => void learn()}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </section>
  );
}
