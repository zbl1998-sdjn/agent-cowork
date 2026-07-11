// 分层记忆装载(企业/用户/项目/本地/会话 五层)(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:仿 Claude Code 的 CLAUDE.md 层级,从五个来源读取记忆文本,按"低→高"优先级
//       拼成一段带标签的合并块,供注入到 agent 的 system 段;同时返回各层存在性/字节数。
// 依赖:标准库(node:fs / node:os / node:path)、同层 memory-filesystem-boundary。
// 导出:loadLayeredMemory。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  beginMemoryFilesystemOperation,
  readManagedMemoryFile,
  type MemoryFilesystemOperation,
} from './memory-filesystem-boundary.js';

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

function clipLayer(text: string, maxBytes: number): string {
  return text.length > maxBytes ? text.slice(0, maxBytes) : text;
}

// enterprisePath 是管理员显式配置的外部只读来源，不属于 userHome/trustedRoot
// 管理目录；保留原有“不可用即不注入”的可选来源语义，与受管本地记忆严格区分。
function readOptionalExternalFile(filePath: string | null | undefined, maxBytes: number): string {
  try {
    if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return clipLayer(fs.readFileSync(filePath, 'utf8'), maxBytes);
    }
  } catch {
    // 显式外部企业来源沿用可选配置语义；受管本地来源不得走此降级分支。
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
  const operations = new Map<string, MemoryFilesystemOperation>();
  const readManagedLayer = (root: string, file: string): string => {
    const resolvedRoot = path.resolve(root);
    let operation = operations.get(resolvedRoot);
    if (!operation) {
      operation = beginMemoryFilesystemOperation(root);
      operations.set(operation.root, operation);
    }
    return clipLayer(readManagedMemoryFile(operation, file).body, perLayerBytes);
  };
  const layers = order.map((layer) => {
    const source = sources[layer];
    let text = '';
    if (layer === 'session') text = String(sessionMemory || '');
    else if (layer === 'enterprise') text = readOptionalExternalFile(source, perLayerBytes);
    else if (source && (layer === 'user' || trustedRoot)) {
      text = readManagedLayer(layer === 'user' ? userHome : String(trustedRoot), source);
    }
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
