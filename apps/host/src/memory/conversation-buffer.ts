// 对话短期缓冲(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:按 conversationId 把每轮成功对话 {role,text,ts} 落到
//       <root>/.AgentCowork/memory/conversations/<safeId>.jsonl,按轮数/字节滚动,
//       供 agent-stream 读缝把「本会话最近若干轮」注入 session 层做同会话连续性
//       (关闭 MASE 也有多轮记忆);对话结束后由 consolidate 提炼成主题知识(Phase 2)。
// 安全:conversationId 归一为安全文件名(防路径逃逸)+ assertTrustedPath jail;写入前
//       统一过 redactText DLP,原始密钥绝不落盘。
// 依赖:node:fs/path、L0 security(redaction/path-policy)、同层 memory-utils。
// 导出:appendConversationTurn / readRecentTurns / formatRecentTurns / conversationBufferPath。
import fs from 'node:fs';
import path from 'node:path';
import { redactText } from '../security/redaction.js';
import { assertTrustedPath } from '../security/path-policy.js';
import { clipUtf8, ensureDirSync, memoryDir, safeReadSync, safeWriteSync } from './memory-utils.js';

const CONVERSATIONS_DIR = 'conversations';
const DEFAULT_MAX_TURNS = 40;
const DEFAULT_MAX_BYTES = 32_768;
const DEFAULT_PER_TURN_BYTES = 4_000;

export type ConversationRole = 'user' | 'assistant';
export type ConversationTurn = { role: ConversationRole; text: string; ts: string };
export type AppendTurnInput = { role: ConversationRole; text: string };
export type BufferBounds = { maxTurns?: number; maxBytes?: number; perTurnBytes?: number };

/** conversationId 归一为安全文件名:仅留 [A-Za-z0-9_-],其余折成 _,限长 64,空则 default。 */
function safeConversationId(conversationId: unknown): string {
  const raw = String(conversationId ?? '').trim();
  const slug = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return slug || 'default';
}

/** 返回该会话缓冲文件路径,并断言仍落在 trustedRoot 内(防逃逸)。 */
export function conversationBufferPath(trustedRoot: unknown, conversationId: unknown): string {
  const dir = path.join(memoryDir(trustedRoot), CONVERSATIONS_DIR);
  const file = path.join(dir, `${safeConversationId(conversationId)}.jsonl`);
  return assertTrustedPath(file, memoryDir(trustedRoot));
}

function normaliseRole(role: unknown): ConversationRole {
  return role === 'assistant' ? 'assistant' : 'user';
}

function parseTurns(body: string): ConversationTurn[] {
  const out: ConversationTurn[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<ConversationTurn>;
      if (parsed && typeof parsed.text === 'string') {
        out.push({ role: normaliseRole(parsed.role), text: parsed.text, ts: String(parsed.ts || '') });
      }
    } catch {
      // 单行损坏跳过,不阻断整段缓冲读取。
    }
  }
  return out;
}

/** 把回合数组按 maxTurns / maxBytes 双上限滚动:先留最近 maxTurns,再从最旧丢到总字节达标。 */
function rollTurns(turns: ConversationTurn[], maxTurns: number, maxBytes: number): ConversationTurn[] {
  let rolled = turns.slice(-Math.max(1, maxTurns));
  const bytesOf = (list: ConversationTurn[]) => Buffer.byteLength(list.map((t) => JSON.stringify(t)).join('\n'), 'utf8');
  while (rolled.length > 1 && bytesOf(rolled) > maxBytes) {
    rolled = rolled.slice(1);
  }
  return rolled;
}

/** 追加一轮对话(先 DLP 脱敏 + 单轮限字节),并按上限滚动落盘。 */
export function appendConversationTurn(
  trustedRoot: unknown,
  conversationId: unknown,
  turn: AppendTurnInput,
  bounds: BufferBounds = {},
): void {
  const text = clipUtf8(redactText(turn?.text) || '', bounds.perTurnBytes ?? DEFAULT_PER_TURN_BYTES);
  if (!text.trim()) return;
  const file = conversationBufferPath(trustedRoot, conversationId);
  ensureDirSync(path.dirname(file));
  const existing = parseTurns(safeReadSync(file, ''));
  existing.push({ role: normaliseRole(turn?.role), text, ts: new Date().toISOString() });
  const rolled = rollTurns(existing, bounds.maxTurns ?? DEFAULT_MAX_TURNS, bounds.maxBytes ?? DEFAULT_MAX_BYTES);
  safeWriteSync(file, `${rolled.map((t) => JSON.stringify(t)).join('\n')}\n`);
}

/** 读回本会话最近若干轮(默认 maxTurns 上限);缓冲不存在返回空数组。 */
export function readRecentTurns(
  trustedRoot: unknown,
  conversationId: unknown,
  options: { maxTurns?: number } = {},
): ConversationTurn[] {
  const file = conversationBufferPath(trustedRoot, conversationId);
  if (!fs.existsSync(file)) return [];
  const turns = parseTurns(safeReadSync(file, ''));
  return turns.slice(-Math.max(1, options.maxTurns ?? DEFAULT_MAX_TURNS));
}

/** 清空某会话缓冲(对话结束提炼成主题知识后调用,避免重复提炼);文件不存在则静默返回。 */
export function clearConversationBuffer(trustedRoot: unknown, conversationId: unknown): void {
  const file = conversationBufferPath(trustedRoot, conversationId);
  try {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  } catch {
    // 清理失败不阻断收尾。
  }
}

const ROLE_LABELS: Record<ConversationRole, string> = { user: '用户', assistant: '助手' };

/** 把最近若干轮渲染成一段带标签的紧凑文本,供注入到 system 段的 session 记忆层;空则返回空串。 */
export function formatRecentTurns(turns: ConversationTurn[]): string {
  if (!Array.isArray(turns) || turns.length === 0) return '';
  const lines = turns
    .filter((t) => t && typeof t.text === 'string' && t.text.trim())
    .map((t) => `- ${ROLE_LABELS[normaliseRole(t.role)]}: ${t.text.trim()}`);
  return lines.length ? `本会话最近对话(供你延续上下文):\n${lines.join('\n')}` : '';
}
