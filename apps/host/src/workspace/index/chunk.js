const DEFAULT_MAX_CHUNK_LINES = 40;
const DEFAULT_MAX_CHUNK_BYTES = 8 * 1024;

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function takeByByteLimit(value, maxBytes) {
  let out = '';
  for (const char of value) {
    if (out && byteLength(out + char) > maxBytes) break;
    if (!out && byteLength(char) > maxBytes) return char;
    out += char;
  }
  return out;
}

function splitOversizedLine(line, maxBytes) {
  const parts = [];
  let rest = line;
  while (rest.length > 0) {
    const part = takeByByteLimit(rest, maxBytes);
    parts.push(part);
    rest = rest.slice(part.length);
  }
  return parts.length ? parts : [''];
}

function makeChunk({ sourcePath, lines, startLine, endLine, ordinal }) {
  const text = lines.join('\n');
  return {
    id: `${sourcePath}:${startLine}-${endLine}:${ordinal}`,
    sourcePath,
    startLine,
    endLine,
    text,
  };
}

export function chunkText({
  text,
  sourcePath,
  maxChunkLines = DEFAULT_MAX_CHUNK_LINES,
  maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES,
} = {}) {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    throw new Error('sourcePath is required');
  }
  if (typeof text !== 'string' || text.length === 0) return [];

  const lineLimit = Math.max(1, Number.isFinite(maxChunkLines) ? Math.floor(maxChunkLines) : DEFAULT_MAX_CHUNK_LINES);
  const byteLimit = Math.max(1, Number.isFinite(maxChunkBytes) ? Math.floor(maxChunkBytes) : DEFAULT_MAX_CHUNK_BYTES);
  const lines = text.split(/\r\n|\n|\r/);
  const chunks = [];
  let current = [];
  let startLine = 1;
  let ordinal = 0;

  function flush(endLine) {
    if (!current.length) return;
    chunks.push(makeChunk({ sourcePath, lines: current, startLine, endLine, ordinal }));
    ordinal += 1;
    current = [];
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNo = i + 1;

    if (byteLength(line) > byteLimit) {
      flush(lineNo - 1);
      for (const part of splitOversizedLine(line, byteLimit)) {
        chunks.push(makeChunk({ sourcePath, lines: [part], startLine: lineNo, endLine: lineNo, ordinal }));
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

