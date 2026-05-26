// @ts-check
import crypto from 'node:crypto';

// AskUserQuestion / clarification protocol.
//
// A turn that needs disambiguation creates a pending question with a few
// labelled options; the UI renders them and posts back an answer. This is the
// transport primitive behind the Claude Cowork "structured clarification"
// pattern — the producer (model / recipe / plan) decides when to ask.

/**
 * @typedef {{ label: string, description: string }} ClarificationOption
 * @typedef {{
 *   id: string,
 *   question: string,
 *   options: ClarificationOption[],
 *   status: 'pending' | 'answered',
 *   answer: unknown,
 *   context: Record<string, unknown>,
 *   createdAt: string,
 *   _ts: number
 * }} ClarificationEntry
 * @typedef {Omit<ClarificationEntry, '_ts'>} PublicClarification
 * @typedef {{
 *   create(input: { question?: unknown, options?: unknown, context?: Record<string, unknown> }): PublicClarification,
 *   get(id: string): PublicClarification | null,
 *   answer(id: string, value: unknown): PublicClarification,
 *   list(): PublicClarification[]
 * }} ClarificationStore
 */

/**
 * @param {{ ttlMs?: number }} [options]
 * @returns {ClarificationStore}
 */
export function createClarificationStore({ ttlMs = 30 * 60 * 1000 } = {}) {
  /** @type {Map<string, ClarificationEntry>} */
  const map = new Map();

  /**
   * @param {ClarificationEntry} entry
   * @returns {PublicClarification}
   */
  function toPublic(entry) {
    const { _ts, ...rest } = entry;
    return rest;
  }

  /** @returns {void} */
  function prune() {
    const now = Date.now();
    for (const [id, entry] of map) {
      if (now - entry._ts > ttlMs) map.delete(id);
    }
  }

  /**
   * @param {unknown} options
   * @returns {ClarificationOption[]}
   */
  function normalizeOptions(options) {
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
        const err = /** @type {Error & { statusCode?: number }} */ (new Error('clarification question is required'));
        err.statusCode = 400;
        throw err;
      }
      prune();
      const id = `clr_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      /** @type {ClarificationEntry} */
      const entry = {
        id,
        question: String(question),
        options: normalizeOptions(options),
        status: 'pending',
        answer: null,
        context: context && typeof context === 'object' && !Array.isArray(context)
          ? /** @type {Record<string, unknown>} */ (context)
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
        const err = /** @type {Error & { statusCode?: number }} */ (new Error(`clarification not found: ${id}`));
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
