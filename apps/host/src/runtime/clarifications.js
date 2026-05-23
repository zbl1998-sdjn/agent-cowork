import crypto from 'node:crypto';

// AskUserQuestion / clarification protocol.
//
// A turn that needs disambiguation creates a pending question with a few
// labelled options; the UI renders them and posts back an answer. This is the
// transport primitive behind the Claude Cowork "structured clarification"
// pattern — the producer (model / recipe / plan) decides when to ask.

export function createClarificationStore({ ttlMs = 30 * 60 * 1000 } = {}) {
  const map = new Map();

  function toPublic(entry) {
    const { _ts, ...rest } = entry;
    return rest;
  }

  function prune() {
    const now = Date.now();
    for (const [id, entry] of map) {
      if (now - entry._ts > ttlMs) map.delete(id);
    }
  }

  function normalizeOptions(options) {
    return (Array.isArray(options) ? options : [])
      .slice(0, 8)
      .map((opt, i) => (typeof opt === 'string'
        ? { label: opt, description: '' }
        : { label: String((opt && opt.label) || `选项 ${i + 1}`), description: (opt && opt.description) || '' }));
  }

  return {
    create({ question, options = [], context = {} }) {
      if (!question || !String(question).trim()) {
        const err = new Error('clarification question is required');
        err.statusCode = 400;
        throw err;
      }
      prune();
      const id = `clr_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const entry = {
        id,
        question: String(question),
        options: normalizeOptions(options),
        status: 'pending',
        answer: null,
        context,
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
        const err = new Error(`clarification not found: ${id}`);
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
