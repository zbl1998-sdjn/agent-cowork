import { useEffect, useState } from 'react';
import {
  forgetMemoryProfile,
  getMemoryProfile,
  learnMemoryProfile,
  type MemoryProfileEntry,
  type MemoryProfileType,
} from '../../lib/api';
import { Button } from '../ui/Button';
import { Empty, ErrorState } from '../ui/StateViews';
import { humanizeError } from '../../lib/friendly-error';

interface MemoryPanelProps {
  trustedRoot: string;
}

// Friendlier labels for the three "kinds" of memory entries. The underlying
// types stay as 'term' / 'project' / 'preference' so the API contract is intact.
const TYPE_LABEL: Record<MemoryProfileType, string> = {
  term: '名词解释',
  project: '项目',
  preference: '偏好',
};

const TYPE_PLACEHOLDER: Record<MemoryProfileType, { key: string; value: string }> = {
  term: { key: '例如:OKR', value: '例如:一种目标管理方法,O 是目标、KR 是关键结果。' },
  project: { key: '例如:春季品牌升级', value: '例如:跟设计部一起,5 月上线,涉及…' },
  preference: { key: '例如:邮件语气', value: '例如:简洁、不寒暄、第一句直接讲事情。' },
};

// Kept for backward compatibility with imports / tests. The visible UI no longer
// renders this as `<code>` — it composes prose instead.
export function formatProfileEntry(entry: MemoryProfileEntry): string {
  return `${TYPE_LABEL[entry.type] || entry.type} · ${entry.key}: ${entry.value}`;
}

export function MemoryPanelStateViews({ error, onRetry }: { error: string; onRetry: () => void }) {
  if (error) {
    return <ErrorState title="记忆没读出来" message={error} onRetry={onRetry} retryLabel="重试" />;
  }
  return <Empty title="还没记下任何东西" message="把你想让 Kimi 记住的名词、项目、偏好写在下面,以后它就能用上。" />;
}

export function MemoryEntryItem({
  entry,
  busy,
  onForget,
}: {
  entry: MemoryProfileEntry;
  busy: boolean;
  onForget: (entry: MemoryProfileEntry) => void;
}) {
  const kindLabel = TYPE_LABEL[entry.type] || entry.type;
  return (
    <li className="memory-entry">
      <div className="memory-entry-head">
        <span className="memory-entry-kind">{kindLabel}</span>
        <span className="memory-entry-key">{entry.key}</span>
      </div>
      <p className="memory-entry-value">{entry.value}</p>
      {entry.evidence && <p className="memory-entry-evidence">怎么知道的:{entry.evidence}</p>}
      <Button variant="secondary" disabled={busy} onClick={() => onForget(entry)}>忘掉</Button>
    </li>
  );
}

export function MemoryPanelSaveAction({
  busy,
  disabled,
  onLearn,
}: {
  busy: boolean;
  disabled: boolean;
  onLearn: () => void;
}) {
  return (
    <Button variant="primary" disabled={disabled} onClick={onLearn}>
      {busy ? '记着…' : '让我记住'}
    </Button>
  );
}

export function MemoryPanel({ trustedRoot }: MemoryPanelProps) {
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<MemoryProfileEntry[]>([]);
  const [type, setType] = useState<MemoryProfileType>('term');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await getMemoryProfile(trustedRoot, query);
      setEntries(res.profile.entries || []);
    } catch (err) {
      setError(humanizeError(err, { action: '读取记忆' }));
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
    setBusy(true);
    setError('');
    try {
      const res = await learnMemoryProfile(
        {
          type,
          key: key.trim(),
          value: value.trim(),
          evidence: evidence.trim() || '你刚刚告诉我的',
        },
        trustedRoot,
      );
      setEntries(res.profile.entries || []);
      setKey('');
      setValue('');
      setEvidence('');
    } catch (err) {
      setError(humanizeError(err, { action: '记下来' }));
    } finally {
      setBusy(false);
    }
  };

  const forget = async (entry: MemoryProfileEntry) => {
    setBusy(true);
    setError('');
    try {
      const res = await forgetMemoryProfile({ type: entry.type, key: entry.key }, trustedRoot);
      setEntries(res.profile.entries || []);
    } catch (err) {
      setError(humanizeError(err, { action: '忘掉' }));
    } finally {
      setBusy(false);
    }
  };

  const placeholders = TYPE_PLACEHOLDER[type];

  return (
    <section className="side-panel memory-panel">
      <h2>我帮你记住的事</h2>
      <p className="memory-intro">
        在这里登记你想让 Kimi 记住的<strong>名词解释</strong>、<strong>项目</strong>和<strong>偏好</strong>;
        以后它在帮你做事时会自动用上。
      </p>

      <div className="panel-row">
        <input
          value={query}
          placeholder="搜一下我记得的事…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void load(); }}
        />
        <Button variant="secondary" disabled={busy} onClick={() => void load()}>{busy ? '读取中…' : '刷新'}</Button>
      </div>

      {error && <MemoryPanelStateViews error={error} onRetry={() => void load()} />}

      <ul className="memory-list">
        {entries.map((entry) => (
          <MemoryEntryItem key={`${entry.type}:${entry.key}`} entry={entry} busy={busy} onForget={(item) => void forget(item)} />
        ))}
        {entries.length === 0 && !error && (
          <li className="panel-empty">
            <MemoryPanelStateViews error="" onRetry={() => void load()} />
          </li>
        )}
      </ul>

      <div className="memory-form">
        <h3>想让我记住什么?</h3>
        <div className="panel-row">
          <select
            className="memory-type-select"
            value={type}
            onChange={(event) => setType(event.target.value as MemoryProfileType)}
            title="选一类"
          >
            <option value="term">名词解释</option>
            <option value="project">项目</option>
            <option value="preference">偏好</option>
          </select>
          <input
            value={key}
            placeholder={placeholders.key}
            onChange={(event) => setKey(event.target.value)}
            title="名称(比如术语本身、项目名、偏好的类别)"
          />
        </div>
        <textarea
          value={value}
          rows={3}
          placeholder={placeholders.value}
          onChange={(event) => setValue(event.target.value)}
          title="解释或内容"
        />
        <details className="memory-advanced">
          <summary>更多(可选):怎么知道的</summary>
          <textarea
            value={evidence}
            rows={2}
            placeholder="例如:你 5/27 在邮件里说过。留空则默认填'你刚刚告诉我的'。"
            onChange={(event) => setEvidence(event.target.value)}
          />
        </details>
        <MemoryPanelSaveAction busy={busy} disabled={busy || !key.trim() || !value.trim()} onLearn={() => void learn()} />
      </div>
    </section>
  );
}
