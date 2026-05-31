// @ts-check
// 记忆层的共享常量与限额(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:集中定义记忆目录/文件名、审计路径、字节与字段长度上限、笔记名校验正则,
//       供 file/sqlite 后端及工具函数统一引用,避免各处硬编码漂移。
// 依赖:仅标准库(node:path)。
// 导出:MEMORY_DIR_NAME / MAIN_MEMORY_FILE / NOTES_DIR / AUDIT_FILE / MEMORY_HEADER、
//       各类 MAX_* 上限、NOTE_NAME_RE、冻结的 MEMORY_LIMITS 汇总对象。

import path from 'node:path';

export const MEMORY_DIR_NAME = '.AgentCowork';
export const MAIN_MEMORY_FILE = 'MEMORY.md';
export const NOTES_DIR = 'memory';
export const AUDIT_FILE = path.join('audit', 'memory.jsonl');
export const MEMORY_HEADER = '# Agent Cowork 项目记忆\n\n这份文件记录 Kimi 在本工作区需要长期记住的事实。每次对话开始时被注入到 system 段。\n\n';

export const MAX_MEMORY_BYTES = 64 * 1024;
export const MAX_FACT_KEY_LENGTH = 96;
export const MAX_FACT_VALUE_LENGTH = 4 * 1024;
export const NOTE_NAME_RE = /^[a-z0-9_.-]{1,96}\.md$/i;

// 对外暴露的限额汇总(冻结以防调用方误改),供工具/路由读取展示。
export const MEMORY_LIMITS = Object.freeze({
  maxMemoryBytes: MAX_MEMORY_BYTES,
  maxFactKeyLength: MAX_FACT_KEY_LENGTH,
  maxFactValueLength: MAX_FACT_VALUE_LENGTH,
});
