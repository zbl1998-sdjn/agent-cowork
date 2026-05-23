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

const LAYER_LABELS = {
  enterprise: '企业策略',
  user: '用户记忆',
  project: '项目记忆',
  local: '本地记忆',
  session: '会话记忆',
};

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

export function loadLayeredMemory({
  trustedRoot,
  userHome = os.homedir(),
  enterprisePath = process.env.KCW_ENTERPRISE_MEMORY || '',
  sessionMemory = '',
  maxBytes = 12000,
  perLayerBytes = 6000,
} = {}) {
  const projectDir = trustedRoot ? path.join(trustedRoot, '.AgentCowork') : null;
  const sources = {
    enterprise: enterprisePath || null,
    user: path.join(userHome, '.AgentCowork', 'MEMORY.md'),
    project: projectDir ? path.join(projectDir, 'MEMORY.md') : null,
    local: projectDir ? path.join(projectDir, 'MEMORY.local.md') : null,
    session: '(session)',
  };
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
