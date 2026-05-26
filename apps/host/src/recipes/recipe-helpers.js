import path from 'node:path';

export function stamp() {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(16).slice(2, 6)}`;
}

export function relSource(source) {
  return source.relativePath || source.path || 'unknown';
}

export function sourceBlock(sources) {
  if (!sources.length) {
    return '- 未提供可读取来源文件';
  }
  return sources
    .map((source) => `- ${relSource(source)}${source.kind ? ` (${source.kind})` : ''}${source.error ? `: ${source.error}` : ''}`)
    .join('\n');
}

export function combinedText(sources) {
  return sources
    .filter((source) => source.content)
    .map((source) => `## ${relSource(source)}\n${source.content}`)
    .join('\n\n')
    .slice(0, 20000);
}

export function artifactPath(trustedRoot, recipeId, filename) {
  return path.join(trustedRoot, '.AgentCowork', 'artifacts', `${recipeId}-${stamp()}-${filename}`);
}

export function markdownOperation(trustedRoot, recipeId, filename, content) {
  return {
    type: 'write',
    path: artifactPath(trustedRoot, recipeId, filename),
    content,
  };
}

export function binaryOperation(trustedRoot, recipeId, filename, buffer) {
  return {
    type: 'write',
    path: artifactPath(trustedRoot, recipeId, filename),
    encoding: 'base64',
    contentBase64: buffer.toString('base64'),
  };
}

export function xlsxOperation(trustedRoot, recipeId, filename, workbook) {
  return binaryOperation(trustedRoot, recipeId, filename, workbook);
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvOperation(trustedRoot, recipeId, filename, rows) {
  const content = rows.map((row) => row.map(csvEscape).join(',')).join('\n') + '\n';
  return {
    type: 'write',
    path: artifactPath(trustedRoot, recipeId, filename),
    content,
  };
}

export function actionRows(text, prompt) {
  const candidates = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#\d.\s]+/, '').trim())
    .filter((line) => line.length >= 4)
    .filter((line) => /待办|行动|负责|跟进|完成|确认|准备|整理|提交|TODO|todo|action/i.test(line))
    .slice(0, 18);
  const lines = candidates.length ? candidates : [prompt || '根据来源材料整理后续行动项'];
  return lines.map((line, index) => [
    String(index + 1),
    line,
    /负责人[:：]\s*([^，,。\s]+)/.exec(line)?.[1] || '待确认',
    /(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|\d{1,2}月\d{1,2}日)/.exec(line)?.[1] || '待确认',
    '未开始',
  ]);
}

export function parseTableRows(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 200);
  const rows = lines
    .map((line) => (line.includes('\t') ? line.split('\t') : line.split(',')))
    .map((row) => row.map((cell) => cell.trim()).filter((cell) => cell !== ''))
    .filter((row) => row.length > 0);
  if (!rows.length) {
    return {
      columns: ['行号', '内容', '清洗状态'],
      rows: [['1', '未发现可解析表格行', '需人工确认']],
    };
  }
  const width = Math.max(...rows.map((row) => row.length));
  const hasHeader = rows[0].length > 1;
  const columns = hasHeader ? rows[0].slice(0, width) : Array.from({ length: width }, (_, index) => `列${index + 1}`);
  const seen = new Set();
  const cleaned = rows.slice(hasHeader ? 1 : 0).map((row, index) => {
    const normalized = Array.from({ length: columns.length }, (_, col) => row[col] || '');
    const key = normalized.join('\u0001');
    const status = normalized.some((cell) => cell === '') ? '存在空字段' : seen.has(key) ? '疑似重复' : '正常';
    seen.add(key);
    return [String(index + 1), ...normalized, status];
  });
  return {
    columns: ['行号', ...columns, '清洗状态'],
    rows: cleaned.slice(0, 80),
  };
}

export function reimbursementRows(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 80);
  const amountPattern = /(?:¥|￥)?\s*(\d+(?:\.\d{1,2})?)/;
  const rows = lines
    .map((line, index) => {
      const amount = amountPattern.exec(line)?.[1] || '';
      const vendor = line.split(/[,\t，。]/)[0]?.slice(0, 40) || `材料 ${index + 1}`;
      return [String(index + 1), vendor, amount, amount ? '待核验发票' : '缺少金额', line.slice(0, 120)];
    })
    .filter((row) => row[2] || /发票|报销|金额|费用|invoice|amount/i.test(row[4]));
  return rows.length ? rows : [['1', '待确认供应商', '', '缺少金额', '未从来源中识别到明确报销条目']];
}
