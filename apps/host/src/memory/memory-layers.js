// @ts-check
// 分层记忆装载(企业/用户/项目/本地/会话 五层)(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:仿 Claude Code 的 CLAUDE.md 层级,从五个来源读取记忆文本,按"低→高"优先级
//       拼成一段带标签的合并块,供注入到 agent 的 system 段;同时返回各层存在性/字节数。
// 依赖:仅标准库(node:fs / node:os / node:path)。
// 导出:loadLayeredMemory。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Five-layer memory system (modeled on Claude Code's CLAUDE.md hierarchy):
//   1. enterprise — org/managed policy        (KCW_ENTERPRISE_MEMORY or config)
//   2. user       — ~/.AgentCowork/MEMORY.md    (personal, cross-project)
//   3. project    — <root>/.AgentCowork/MEMORY.md (shared, source-controlled)
//   4. local      — <root>/.AgentCowork/MEMORY.local.md (personal overrides, gitignored)
//   5. session    — ephemeral notes for the current run
// Layers are concatenated lowest→highest precedence so later layers refine
// earlier ones; the combined block is injected into the agent's system prompt.

/**
 * @typedef {'enterprise' | 'user' | 'project' | 'local' | 'session'} LayerName
 * @typedef {{ trustedRoot?: string, userHome?: string, enterprisePath?: string, sessionMemory?: string, maxBytes?: number, perLayerBytes?: number }} LayeredMemoryOptions
 */

/** @type {Record<LayerName, string>} */
const LAYER_LABELS = {
  enterprise: '企业策略',
  user: '用户记忆',
  project: '项目记忆',
  local: '本地记忆',
  session: '会话记忆',
};

/** 安全读取某层文件并按 maxBytes 截断;路径缺失或不可读时静默返回空串。 @param {string | null | undefined} filePath @param {number} maxBytes */
function readIfFile(filePath, maxBytes) {
  try {
    if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const text = fs.readFileSync(filePath, 'utf8');
      return text.length > maxBytes ? text.slice(0, maxBytes) : text;
    }
  } catch {
    // unreadable layer is simply absent
  }
  return '';
}

/** 装载五层记忆并合并为单段 system 文本;另回报各层来源与字节数(便于诊断)。 @param {LayeredMemoryOptions} [options] */
export function loadLayeredMemory({
  trustedRoot,
  userHome = os.homedir(),
  enterprisePath = process.env.KCW_ENTERPRISE_MEMORY || '',
  sessionMemory = '',
  maxBytes = 12000,
  perLayerBytes = 6000,
  } = {}) {
  const projectDir = trustedRoot ? path.join(trustedRoot, '.AgentCowork') : null;
  /** @type {Record<LayerName, string | null>} */
  const sources = {
    enterprise: enterprisePath || null,
    user: path.join(userHome, '.AgentCowork', 'MEMORY.md'),
    project: projectDir ? path.join(projectDir, 'MEMORY.md') : null,
    local: projectDir ? path.join(projectDir, 'MEMORY.local.md') : null,
    session: '(session)',
  };
  /** @type {LayerName[]} */
  const order = ['enterprise', 'user', 'project', 'local', 'session'];
  const layers = order.map((layer) => {
    const text = layer === 'session' ? String(sessionMemory || '') : readIfFile(sources[layer], perLayerBytes);
    return { layer, label: LAYER_LABELS[layer], source: sources[layer], text, present: Boolean(text && text.trim()) };
  });
  const combined = layers
    .filter((l) => l.present)
    .map((l) => `## ${l.label} [${l.layer}]\n${l.text.trim()}`)
    .join('\n\n')
    .slice(0, maxBytes);
  return {
    text: combined,
    layers: layers.map((l) => ({ layer: l.layer, label: l.label, source: l.source, present: l.present, bytes: Buffer.byteLength(l.text || '') })),
  };
}
