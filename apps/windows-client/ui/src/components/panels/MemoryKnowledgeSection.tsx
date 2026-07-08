// 主题知识区(UI · panels 子组件)
// ---------------------------------------------------------------------------
// 职责:在记忆面板里展示由过往对话自动提炼的主题知识——active 可删、pending 可批准/删,
//       是"不污染"的最后一道人控闸。纯展示 + 调 lib/api;分组等纯逻辑抽出便于单测。
import { useCallback, useEffect, useState } from 'react';
import { approveKnowledge, deleteKnowledge, getKnowledge, type KnowledgeItem } from '../../lib/api';
import { Button } from '../ui/Button';
import { Empty, ErrorState, Loading } from '../ui/StateViews';

export interface KnowledgeGroups {
  active: KnowledgeItem[];
  pending: KnowledgeItem[];
}

/** 把知识条目按状态分组(纯函数,便于单测)。 */
export function groupKnowledge(items: KnowledgeItem[]): KnowledgeGroups {
  const active: KnowledgeItem[] = [];
  const pending: KnowledgeItem[] = [];
  for (const item of items || []) {
    if (item.status === 'pending') pending.push(item);
    else active.push(item);
  }
  return { active, pending };
}

/** 置信度百分比展示(纯函数)。 */
export function confidenceLabel(confidence: number): string {
  const pct = Math.round(Math.min(1, Math.max(0, Number(confidence) || 0)) * 100);
  return `${pct}%`;
}

function KnowledgeRow({ item, onApprove, onDelete }: {
  item: KnowledgeItem;
  onApprove?: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <li className="memory-knowledge-item">
      <div className="memory-knowledge-head">
        <span className="memory-knowledge-topic">[{item.topic}]</span>
        <strong className="memory-knowledge-title">{item.title}</strong>
        <span className="memory-knowledge-confidence">{confidenceLabel(item.confidence)}</span>
      </div>
      <p className="memory-knowledge-content">{item.content}</p>
      <div className="memory-knowledge-actions">
        {onApprove && <Button variant="secondary" onClick={() => onApprove(item.id)}>批准</Button>}
        <Button variant="secondary" onClick={() => onDelete(item.id)}>删除</Button>
      </div>
    </li>
  );
}

export function MemoryKnowledgeSection({ trustedRoot }: { trustedRoot?: string }) {
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await getKnowledge(undefined, trustedRoot);
      setItems(Array.isArray(res.items) ? res.items : []);
    } catch (e) {
      setError((e as Error).message || '加载主题知识失败');
    } finally {
      setLoading(false);
    }
  }, [trustedRoot]);

  useEffect(() => { void reload(); }, [reload]);

  const onApprove = useCallback(async (id: string) => { try { await approveKnowledge(id, trustedRoot); await reload(); } catch (e) { setError((e as Error).message); } }, [reload, trustedRoot]);
  const onDelete = useCallback(async (id: string) => { try { await deleteKnowledge(id, trustedRoot); await reload(); } catch (e) { setError((e as Error).message); } }, [reload, trustedRoot]);

  const { active, pending } = groupKnowledge(items);

  return (
    <section className="memory-knowledge" aria-label="主题知识">
      <div className="panel-row">
        <strong>主题知识(过往对话提炼)</strong>
        <Button variant="secondary" onClick={() => void reload()} disabled={loading}>刷新</Button>
      </div>
      {loading && <Loading message="加载主题知识…" />}
      {error && <ErrorState title="主题知识加载失败" message={error} />}
      {!loading && !error && items.length === 0 && (
        <Empty title="暂无主题知识" message="多聊几轮并切换对话后,会自动把耐用信息提炼到这里。" />
      )}
      {pending.length > 0 && (
        <div className="memory-knowledge-pending">
          <p className="panel-note">待确认({pending.length}) —— 置信度不高,批准后才会在新对话里被召回:</p>
          <ul>{pending.map((it) => <KnowledgeRow key={it.id} item={it} onApprove={onApprove} onDelete={onDelete} />)}</ul>
        </div>
      )}
      {active.length > 0 && (
        <div className="memory-knowledge-active">
          <p className="panel-note">已生效({active.length}) —— 相关时会注入到新对话:</p>
          <ul>{active.map((it) => <KnowledgeRow key={it.id} item={it} onDelete={onDelete} />)}</ul>
        </div>
      )}
    </section>
  );
}
