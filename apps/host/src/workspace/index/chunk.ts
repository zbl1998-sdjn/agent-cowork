// 文本分块(host · L1 领域层 · workspace/index)
// ---------------------------------------------------------------------------
// 职责:把文档文本切成带行号区间的检索块(chunk),受「最多行数 + 最多字节」双重约束;
//       超长单行会按 UTF-8 字节边界再切,保证每块体积有界。纯函数、确定性、可测。
// 依赖:无。导出:chunkText。
const DEFAULT_MAX_CHUNK_LINES = 40;
const DEFAULT_MAX_CHUNK_BYTES = 8 * 1024;

export type WorkspaceChunk = {
  id: string;
  sourcePath: string;
  startLine: number;
  endLine: number;
  text: string;
};
export type ChunkTextInput = {
  text: string;
  sourcePath: string;
  maxChunkLines?: number;
  maxChunkBytes?: number;
};
type MakeChunkInput = {
  sourcePath: string;
  lines: string[];
  startLine: number;
  endLine: number;
  ordinal: number;
};

/**
 * 返回字符串的 UTF-8 字节数,用于按传输/存储体积切块而不是按字符数误判。
 */
function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * 从字符串头部取出不超过 maxBytes 的片段;单个字符超限时仍返回该字符以保证游标前进。
 */
function takeByByteLimit(value: string, maxBytes: number): string {
  let out = '';
  for (const char of value) {
    if (out && byteLength(out + char) > maxBytes) break;
    if (!out && byteLength(char) > maxBytes) return char;
    out += char;
  }
  return out;
}

/**
 * 把超长单行拆成多个字节有界片段,避免一行大文本撑爆检索块。
 */
function splitOversizedLine(line: string, maxBytes: number): string[] {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > 0) {
    const part = takeByByteLimit(rest, maxBytes);
    parts.push(part);
    rest = rest.slice(part.length);
  }
  return parts.length ? parts : [''];
}

/**
 * 组装检索块并把源路径、行号区间和序号编码进稳定 id。
 */
function makeChunk({ sourcePath, lines, startLine, endLine, ordinal }: MakeChunkInput): WorkspaceChunk {
  const text = lines.join('\n');
  return {
    id: `${sourcePath}:${startLine}-${endLine}:${ordinal}`,
    sourcePath,
    startLine,
    endLine,
    text,
  };
}

/**
 * 把文本切成 WorkspaceChunk[]:按行累积,超行数/字节即 flush;超长单行先按字节切分。
 */
export function chunkText({
  text,
  sourcePath,
  maxChunkLines = DEFAULT_MAX_CHUNK_LINES,
  maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES,
}: Partial<ChunkTextInput> = {}): WorkspaceChunk[] {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    throw new Error('sourcePath is required');
  }
  const chunkSourcePath = sourcePath;
  if (typeof text !== 'string' || text.length === 0) return [];

  const lineLimit = Math.max(1, Number.isFinite(maxChunkLines) ? Math.floor(maxChunkLines) : DEFAULT_MAX_CHUNK_LINES);
  const byteLimit = Math.max(1, Number.isFinite(maxChunkBytes) ? Math.floor(maxChunkBytes) : DEFAULT_MAX_CHUNK_BYTES);
  const lines = text.split(/\r\n|\n|\r/);
  const chunks: WorkspaceChunk[] = [];
  let current: string[] = [];
  let startLine = 1;
  let ordinal = 0;

  /**
   * 把当前累积行刷成块;调用方负责在刷出后更新下一块起始行。
   */
  function flush(endLine: number): void {
    if (!current.length) return;
    chunks.push(makeChunk({ sourcePath: chunkSourcePath, lines: current, startLine, endLine, ordinal }));
    ordinal += 1;
    current = [];
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;

    if (byteLength(line) > byteLimit) {
      flush(lineNo - 1);
      for (const part of splitOversizedLine(line, byteLimit)) {
        chunks.push(makeChunk({ sourcePath: chunkSourcePath, lines: [part], startLine: lineNo, endLine: lineNo, ordinal }));
        ordinal += 1;
      }
      startLine = lineNo + 1;
      continue;
    }

    const next = [...current, line];
    const tooManyLines = next.length > lineLimit;
    const tooManyBytes = byteLength(next.join('\n')) > byteLimit;
    if (current.length && (tooManyLines || tooManyBytes)) {
      flush(lineNo - 1);
      startLine = lineNo;
    }
    if (!current.length) startLine = lineNo;
    current.push(line);
  }
  flush(lines.length);

  return chunks;
}
