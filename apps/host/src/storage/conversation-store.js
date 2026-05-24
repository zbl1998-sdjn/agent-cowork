import fs from 'node:fs';
import path from 'node:path';

// Per-user conversation persistence. Each conversation is one JSON document under
//   <trustedRoot>/.AgentCowork/conversations/<tenantId>/<userId>/<convId>.json
// so a signed-in user's history follows their account across devices/instances
// that share the same data root. Guests (tenant_local/user_local) get the same
// treatment, which keeps the desktop's offline experience intact.

const ROOT_DIR = '.AgentCowork';
const CONV_DIR = 'conversations';
const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_BYTES = 1024 * 1024; // hard cap per conversation document
const MAX_TITLE = 200;

function normaliseSegment(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  // Keep only filesystem-safe characters; collapse the rest so a hostile
  // tenant/user id can never escape the conversations directory.
  const safe = text.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96);
  return safe || fallback;
}

function ensureTrustedRoot(trustedRoot) {
  const root = String(trustedRoot || '').trim();
  if (!root) throw new Error('trustedRoot is required');
  return path.resolve(root);
}

function userDir(trustedRoot, context = {}) {
  const tenant = normaliseSegment(context.tenantId, 'tenant_local');
  const user = normaliseSegment(context.userId, 'user_local');
  return path.join(ensureTrustedRoot(trustedRoot), ROOT_DIR, CONV_DIR, tenant, user);
}

function cleanId(id) {
  const text = String(id || '').trim();
  if (!ID_RE.test(text)) throw new Error('invalid conversation id');
  return text;
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  // Cap the stored history so a runaway conversation can't blow the byte limit.
  return messages.slice(-200);
}

function safeOptionalId(value) {
  const text = String(value || '').trim();
  return ID_RE.test(text) ? text : '';
}

function sanitizeBranches(branches) {
  if (!Array.isArray(branches)) return [];
  return branches.slice(-12).map((branch, index) => {
    const id = safeOptionalId(branch && branch.id) || (index === 0 ? 'main' : `branch-${index}`);
    return {
      id,
      title: String((branch && branch.title) || (index === 0 ? '主线' : `分支 ${index}`)).slice(0, MAX_TITLE),
      ...(safeOptionalId(branch && branch.parentBranchId) ? { parentBranchId: String(branch.parentBranchId) } : {}),
      ...(branch && branch.baseMessageId ? { baseMessageId: String(branch.baseMessageId).slice(0, 96) } : {}),
      ...(branch && branch.createdAt ? { createdAt: String(branch.createdAt).slice(0, 64) } : {}),
      messages: sanitizeMessages(branch && branch.messages),
    };
  });
}

function summarise(conv) {
  return {
    id: conv.id,
    title: conv.title || '新对话',
    pinned: Boolean(conv.pinned),
    messageCount: Array.isArray(conv.messages) ? conv.messages.length : 0,
    branchCount: Array.isArray(conv.branches) ? conv.branches.length : 0,
    activeBranchId: conv.activeBranchId,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
  };
}

export class FileConversationStore {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
  }

  _readDir(trustedRoot, context, mapper) {
    const dir = userDir(trustedRoot, context);
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const conv = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (conv && conv.id) out.push(mapper(conv));
      } catch {
        /* skip corrupt document */
      }
    }
    out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return out;
  }

  list(trustedRoot, context = {}) {
    return this._readDir(trustedRoot, context, summarise);
  }

  // Paginated + title-searched summaries: { items, total }.
  query(trustedRoot, context = {}, { q = '', limit = 30, offset = 0 } = {}) {
    const all = this._readDir(trustedRoot, context, summarise);
    const ql = String(q || '').trim().toLowerCase();
    const filtered = ql ? all.filter((c) => (c.title || '').toLowerCase().includes(ql)) : all;
    const lim = Math.min(Math.max(Number(limit) || 30, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    return { items: filtered.slice(off, off + lim), total: filtered.length };
  }

  listFull(trustedRoot, context = {}, { limit } = {}) {
    const all = this._readDir(trustedRoot, context, (conv) => conv);
    return typeof limit === 'number' ? all.slice(0, Math.max(0, limit)) : all;
  }

  get(trustedRoot, id, context = {}) {
    const file = path.join(userDir(trustedRoot, context), `${cleanId(id)}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  save(trustedRoot, conv, context = {}) {
    const id = cleanId(conv && conv.id);
    const dir = userDir(trustedRoot, context);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.json`);
    const existing = fs.existsSync(file) ? this.get(trustedRoot, id, context) : null;
    const now = this.now().toISOString();
    const branches = sanitizeBranches(conv && conv.branches);
    const requestedActive = safeOptionalId(conv && conv.activeBranchId);
    const activeBranchId = branches.some((branch) => branch.id === requestedActive)
      ? requestedActive
      : branches[0]?.id;
    const record = {
      id,
      title: String((conv && conv.title) || '新对话').slice(0, MAX_TITLE),
      pinned: Boolean(conv && conv.pinned),
      messages: sanitizeMessages(conv && conv.messages),
      ...(branches.length ? { activeBranchId, branches } : {}),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    let body = JSON.stringify(record);
    if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) {
      // Trim history further until it fits rather than rejecting the save.
      record.messages = record.messages.slice(-50);
      body = JSON.stringify(record);
    }
    fs.writeFileSync(file, body, 'utf8');
    return summarise(record);
  }

  remove(trustedRoot, id, context = {}) {
    const file = path.join(userDir(trustedRoot, context), `${cleanId(id)}.json`);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  }
}

export function createConversationStore({ backend = 'file', now } = {}) {
  // Postgres adapter (createPostgresConversationStore) mirrors this interface and
  // is selected by the server when KCW_STORE=postgres.
  void backend;
  return new FileConversationStore({ now });
}
