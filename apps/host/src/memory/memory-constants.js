// @ts-check

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

export const MEMORY_LIMITS = Object.freeze({
  maxMemoryBytes: MAX_MEMORY_BYTES,
  maxFactKeyLength: MAX_FACT_KEY_LENGTH,
  maxFactValueLength: MAX_FACT_VALUE_LENGTH,
});
