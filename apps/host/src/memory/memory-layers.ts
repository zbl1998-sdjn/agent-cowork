// 分层记忆装载(企业/用户/项目/本地/会话 五层)(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:仿 Claude Code 的 CLAUDE.md 层级,从五个来源读取记忆文本,按"低→高"优先级
//       拼成一段带标签的合并块,供注入到 agent 的 system 段;同时返回各层存在性/字节数。
// 依赖:仅标准库(node:fs / node:os / node:path)。
// 导出:loadLayeredMemory。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 五层按低→高优先级拼接:enterprise/user/project/local/session;越后的层可以修正前层。
// 合并后的块注入 agent system prompt,同时保留每层来源与字节数便于 UI 展示。

export type LayerName = 'enterprise' | 'user' | 'project' | 'local' | 'session';
export type LayeredMemoryOptions = {
  trustedRoot?: string;
  userHome?: string;
  enterprisePath?: string;
  sessionMemory?: string;
  maxBytes?: number;
  perLayerBytes?: number;
};
export type LayeredMemoryLayer = {
  layer: LayerName;
  label: string;
  source: string | null;
  present: boolean;
  bytes: number;
};
export type LayeredMemoryResult = { text: string; layers: LayeredMemoryLayer[] };

const LAYER_LABELS: Record<LayerName, string> = {
  enterprise: '企业策略',
  user: '用户记忆',
  project: '项目记忆',
  local: '本地记忆',
  session: '会话记忆',
};

function readIfFile(filePath: string | null | undefined, maxBytes: number): string {
  try {
    if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const text = fs.readFileSync(filePath, 'utf8');
      return text.length > maxBytes ? text.slice(0, maxBytes) : text;
    }
  } catch {
    // 不可读层按不存在处理,避免记忆文件损坏阻断运行。
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
}: LayeredMemoryOptions = {}): LayeredMemoryResult {
  const projectDir = trustedRoot ? path.join(trustedRoot, '.AgentCowork') : null;
  const sources: Record<LayerName, string | null> = {
    enterprise: enterprisePath || null,
    user: path.join(userHome, '.AgentCowork', 'MEMORY.md'),
    project: projectDir ? path.join(projectDir, 'MEMORY.md') : null,
    local: projectDir ? path.join(projectDir, 'MEMORY.local.md') : null,
    session: '(session)',
  };
  const order: LayerName[] = ['enterprise', 'user', 'project', 'local', 'session'];
  const layers = order.map((layer) => {
    const text = layer === 'session' ? String(sessionMemory || '') : readIfFile(sources[layer], perLayerBytes);
    return { layer, label: LAYER_LABELS[layer], source: sources[layer], text, present: Boolean(text && text.trim()) };
  });
  const combined = layers
    .filter((layer) => layer.present)
    .map((layer) => `## ${layer.label} [${layer.layer}]\n${layer.text.trim()}`)
    .join('\n\n')
    .slice(0, maxBytes);
  return {
    text: combined,
    layers: layers.map((layer) => ({
      layer: layer.layer,
      label: layer.label,
      source: layer.source,
      present: layer.present,
      bytes: Buffer.byteLength(layer.text || ''),
    })),
  };
}
