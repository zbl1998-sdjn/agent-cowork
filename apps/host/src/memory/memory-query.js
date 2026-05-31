// @ts-check
// 记忆查询/组块的后端无关逻辑(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:把"读主记忆文本→裁剪成 system 块""列笔记元信息"等只读拼装逻辑抽出,
//       让 file/sqlite 两种后端共用同一套构建函数(后端只需实现 SyncMemoryStoreLike)。
// 依赖:同目录 memory-constants(上限)、memory-utils(clipUtf8)。
// 导出:buildMemorySystemBlockFromText / buildMemorySystemBlockFromStore /
//       loadMemoryContextFromStore。

import { MAX_MEMORY_BYTES } from './memory-constants.js';
import { clipUtf8 } from './memory-utils.js';

/**
 * @typedef {{ name: string, size: number, modifiedAt: string, path?: string }} MemoryNote
 * @typedef {{ readMainMemory(trustedRoot: unknown, context?: Record<string, unknown>): string, buildMemorySystemBlock(trustedRoot: unknown, options?: MemoryQueryOptions): string, listMemoryNotes(trustedRoot: unknown, context?: Record<string, unknown>): MemoryNote[] }} SyncMemoryStoreLike
 * @typedef {{ maxBytes?: number, context?: Record<string, unknown> }} MemoryQueryOptions
 */

/**
 * 把主记忆原文裁成可注入的 system 块:空白则返回空串,否则按 [512, MAX] 夹取后截断去空白。
 * @param {string} main
 * @param {{ maxBytes?: number }} [options]
 * @returns {string}
 */
export function buildMemorySystemBlockFromText(main, { maxBytes = 4096 } = {}) {
  if (!main.trim()) {
    return '';
  }
  const clipped = clipUtf8(main, Math.max(512, Math.min(MAX_MEMORY_BYTES, maxBytes)));
  return clipped.trim();
}

/**
 * 从后端读主记忆再构建 system 块;任何读取异常都吞掉并降级为空串(注入失败不应阻断对话)。
 * @param {SyncMemoryStoreLike} store
 * @param {unknown} trustedRoot
 * @param {MemoryQueryOptions} [options]
 * @returns {string}
 */
export function buildMemorySystemBlockFromStore(store, trustedRoot, options = {}) {
  try {
    return buildMemorySystemBlockFromText(store.readMainMemory(trustedRoot, options.context || {}), options);
  } catch {
    return '';
  }
}

/**
 * 汇总记忆上下文:system 块文本 + 字节数 + 是否启用 + 笔记元信息列表(仅暴露 name/size/modifiedAt)。
 * @param {SyncMemoryStoreLike} store
 * @param {unknown} trustedRoot
 * @param {MemoryQueryOptions} [options]
 * @returns {{ enabled: boolean, bytes: number, text: string, notes: MemoryNote[] }}
 */
export function loadMemoryContextFromStore(store, trustedRoot, { maxBytes = 4096, context = {} } = {}) {
  const block = store.buildMemorySystemBlock(trustedRoot, { maxBytes, context });
  const notes = store.listMemoryNotes(trustedRoot, context).map((note) => ({
    name: note.name,
    size: note.size,
    modifiedAt: note.modifiedAt,
  }));
  return {
    enabled: Boolean(block),
    bytes: Buffer.byteLength(block, 'utf8'),
    text: block,
    notes,
  };
}
