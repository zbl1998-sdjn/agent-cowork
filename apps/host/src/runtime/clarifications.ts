// 澄清提问(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:AskUserQuestion / 澄清协议的传输原语。需要消歧的回合创建一个带选项的待决问题,UI 渲染并回传答案。
//       这是「结构化澄清」背后的待决登记(带 TTL)。依赖:node:crypto。导出:澄清登记表。
import crypto from 'node:crypto';
import {
  requireIdentityScopeFrom,
  type IdentityScope,
} from '../security/identity-scope.js';

export type ClarificationOption = { label: string; description: string };
type ClarificationEntry = {
  id: string;
  question: string;
  options: ClarificationOption[];
  status: 'pending' | 'answered';
  answer: unknown;
  context: Record<string, unknown>;
  createdAt: string;
  _ts: number;
};
export type PublicClarification = Omit<ClarificationEntry, '_ts'>;
type ClarificationContext = Record<string, unknown>;
export type ClarificationStore = {
  create(input: { question?: unknown; options?: unknown; context: ClarificationContext }): PublicClarification;
  get(id: string, context: ClarificationContext): PublicClarification | null;
  answer(id: string, value: unknown, context: ClarificationContext): PublicClarification;
  list(context: ClarificationContext): PublicClarification[];
};

/**
 * 创建带 TTL 的澄清登记表;生产方只登记问题,UI 负责展示并回填答案。
 */
export function createClarificationStore({ ttlMs = 30 * 60 * 1000 }: { ttlMs?: number } = {}): ClarificationStore {
  const map = new Map<string, ClarificationEntry>();

  function owner(context: ClarificationContext): IdentityScope | null {
    try {
      return requireIdentityScopeFrom(context, { label: 'clarification identity' });
    } catch {
      return null;
    }
  }

  function ownedEntry(id: string, context: ClarificationContext): ClarificationEntry | null {
    const entry = map.get(id);
    const expected = entry ? owner(entry.context) : null;
    const actual = owner(context);
    return entry && expected && actual
      && expected.tenantId === actual.tenantId
      && expected.userId === actual.userId
      ? entry
      : null;
  }

  function toPublic(entry: ClarificationEntry): PublicClarification {
    const { _ts, ...rest } = entry;
    return rest;
  }

  function prune(): void {
    const now = Date.now();
    for (const [id, entry] of map) {
      if (now - entry._ts > ttlMs) map.delete(id);
    }
  }

  /**
   * 标准化选项并限制最多 8 个,避免模型输出过长导致 UI 难以扫描。
   */
  function normalizeOptions(options: unknown): ClarificationOption[] {
    return (Array.isArray(options) ? options : [])
      .slice(0, 8)
      .map((opt, i) => (typeof opt === 'string'
        ? { label: opt, description: '' }
        : {
          label: String((opt && typeof opt === 'object' && 'label' in opt && opt.label) || `选项 ${i + 1}`),
          description: String((opt && typeof opt === 'object' && 'description' in opt && opt.description) || ''),
        }));
  }

  return {
    create({ question, options = [], context }) {
      if (!question || !String(question).trim()) {
        const err = new Error('clarification question is required') as Error & { statusCode?: number };
        err.statusCode = 400;
        throw err;
      }
      const entryOwner = owner(context);
      if (!entryOwner) {
        const err = new Error('clarification owner context is required') as Error & { statusCode?: number };
        err.statusCode = 400;
        throw err;
      }
      prune();
      const id = `clr_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const entry: ClarificationEntry = {
        id,
        question: String(question),
        options: normalizeOptions(options),
        status: 'pending',
        answer: null,
        context: Object.freeze({
          tenantId: entryOwner.tenantId,
          userId: entryOwner.userId,
        }),
        createdAt: new Date().toISOString(),
        _ts: Date.now(),
      };
      map.set(id, entry);
      return toPublic(entry);
    },
    get(id, context) {
      const entry = ownedEntry(id, context);
      return entry ? toPublic(entry) : null;
    },
    answer(id, value, context) {
      const entry = ownedEntry(id, context);
      if (!entry) {
        const err = new Error(`clarification not found: ${id}`) as Error & { statusCode?: number };
        err.statusCode = 404;
        throw err;
      }
      entry.status = 'answered';
      entry.answer = value;
      entry._ts = Date.now();
      return toPublic(entry);
    },
    list(context) {
      prune();
      return [...map.values()]
        .filter((entry) => ownedEntry(entry.id, context))
        .map(toPublic);
    },
  };
}
