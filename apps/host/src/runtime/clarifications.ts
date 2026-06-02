// 澄清提问(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:AskUserQuestion / 澄清协议的传输原语。需要消歧的回合创建一个带选项的待决问题,UI 渲染并回传答案。
//       这是「结构化澄清」背后的待决登记(带 TTL)。依赖:node:crypto。导出:澄清登记表。
import crypto from 'node:crypto';

// AskUserQuestion / clarification protocol.
//
// A turn that needs disambiguation creates a pending question with a few
// labelled options; the UI renders them and posts back an answer. This is the
// transport primitive behind the Claude Cowork "structured clarification"
// pattern — the producer (model / recipe / plan) decides when to ask.

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
export type ClarificationStore = {
  create(input: { question?: unknown; options?: unknown; context?: Record<string, unknown> }): PublicClarification;
  get(id: string): PublicClarification | null;
  answer(id: string, value: unknown): PublicClarification;
  list(): PublicClarification[];
};

/**
 */
export function createClarificationStore({ ttlMs = 30 * 60 * 1000 }: { ttlMs?: number } = {}): ClarificationStore {
  const map = new Map<string, ClarificationEntry>();

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
    create({ question, options = [], context = {} }) {
      if (!question || !String(question).trim()) {
        const err = new Error('clarification question is required') as Error & { statusCode?: number };
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
        context: context && typeof context === 'object' && !Array.isArray(context)
          ? context
          : {},
        createdAt: new Date().toISOString(),
        _ts: Date.now(),
      };
      map.set(id, entry);
      return toPublic(entry);
    },
    get(id) {
      const entry = map.get(id);
      return entry ? toPublic(entry) : null;
    },
    answer(id, value) {
      const entry = map.get(id);
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
    list() {
      prune();
      return [...map.values()].map(toPublic);
    },
  };
}
