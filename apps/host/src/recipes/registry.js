import path from 'node:path';
import { createXlsxWorkbook } from '../artifacts/xlsx-writer.js';

const RECIPES = [
  {
    id: 'meeting-actions',
    name: '会议纪要转行动项',
    description: '从会议记录中提取结论、负责人、截止时间和待办清单。',
    output: 'Markdown + XLSX',
    riskLevel: 'safe-write',
  },
  {
    id: 'excel-cleaning',
    name: '表格清洗',
    description: '读取 CSV/XLSX，去空行、标记重复和缺失字段，生成清洗结果。',
    output: 'Markdown + XLSX',
    riskLevel: 'safe-write',
  },
  {
    id: 'reimbursement',
    name: '报销材料整理',
    description: '汇总发票、金额、供应商和缺失材料，生成报销清单。',
    output: 'CSV + Markdown',
    riskLevel: 'safe-write',
  },
  {
    id: 'folder-organize',
    name: '文件夹整理',
    description: '按类型和主题生成整理建议，默认只写计划不移动原文件。',
    output: 'Markdown',
    riskLevel: 'preview-only',
  },
  {
    id: 'contract-summary',
    name: '合同摘要',
    description: '提取合同主体、付款、续约、风险点和待确认事项。',
    output: 'Markdown',
    riskLevel: 'safe-write',
  },
  {
    id: 'feedback-clusters',
    name: '反馈聚类',
    description: '把用户反馈按主题、严重度和建议动作聚合。',
    output: 'Markdown',
    riskLevel: 'safe-write',
  },
  {
    id: 'summary-report',
    name: '总结报告',
    description: '把本地材料整理成结构化周报、项目总结或管理摘要。',
    output: 'Markdown',
    riskLevel: 'safe-write',
  },
  {
    id: 'email-draft',
    name: '邮件草稿',
    description: '基于本地上下文生成中文商务邮件草稿和附件清单。',
    output: 'Markdown',
    riskLevel: 'safe-write',
  },
];

function stamp() {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(16).slice(2, 6)}`;
}

function relSource(source) {
  return source.relativePath || source.path || 'unknown';
}

function sourceBlock(sources) {
  if (!sources.length) {
    return '- 未提供可读取来源文件';
  }
  return sources
    .map((source) => `- ${relSource(source)}${source.kind ? ` (${source.kind})` : ''}${source.error ? `: ${source.error}` : ''}`)
    .join('\n');
}

function combinedText(sources) {
  return sources
    .filter((source) => source.content)
    .map((source) => `## ${relSource(source)}\n${source.content}`)
    .join('\n\n')
    .slice(0, 20000);
}

function artifactPath(trustedRoot, recipeId, filename) {
  return path.join(trustedRoot, '.KimiCowork', 'artifacts', `${recipeId}-${stamp()}-${filename}`);
}

function markdownOperation(trustedRoot, recipeId, filename, content) {
  return {
    type: 'write',
    path: artifactPath(trustedRoot, recipeId, filename),
    content,
  };
}

function xlsxOperation(trustedRoot, recipeId, filename, workbook) {
  return {
    type: 'write',
    path: artifactPath(trustedRoot, recipeId, filename),
    encoding: 'base64',
    contentBase64: workbook.toString('base64'),
  };
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvOperation(trustedRoot, recipeId, filename, rows) {
  const content = rows.map((row) => row.map(csvEscape).join(',')).join('\n') + '\n';
  return {
    type: 'write',
    path: artifactPath(trustedRoot, recipeId, filename),
    content,
  };
}

function actionRows(text, prompt) {
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

function parseTableRows(text) {
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

function reimbursementRows(text) {
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

function genericMarkdown(recipe, prompt, sources) {
  const text = combinedText(sources);
  const excerpt = text ? text.slice(0, 2000) : '暂无可读取正文。';
  return [
    `# ${recipe.name}`,
    '',
    `- 用户指令: ${prompt || '未填写'}`,
    `- 模板: ${recipe.id}`,
    `- 输出类型: ${recipe.output}`,
    '',
    '## 来源',
    sourceBlock(sources),
    '',
    '## 来源摘要',
    excerpt,
    '',
    '## 处理结果',
    excerpt,
    '',
    '## 下一步',
    '- 请确认来源是否完整。',
    '- 审批后该产物会写入本地可信工作区。',
    '',
  ].join('\n');
}

function meetingRecipe(trustedRoot, recipe, prompt, sources) {
  const text = combinedText(sources);
  const rows = actionRows(text, prompt);
  return [
    markdownOperation(
      trustedRoot,
      recipe.id,
      '会议行动项.md',
      [
        '# 会议纪要行动项',
        '',
        `- 用户指令: ${prompt || '未填写'}`,
        '',
        '## 来源',
        sourceBlock(sources),
        '',
        '## 行动项',
        ...rows.map((row) => `- ${row[1]} | 负责人: ${row[2]} | 截止: ${row[3]} | 状态: ${row[4]}`),
        '',
      ].join('\n'),
    ),
    xlsxOperation(
      trustedRoot,
      recipe.id,
      '会议行动项.xlsx',
      createXlsxWorkbook({
        sheetName: '行动项',
        columns: ['序号', '行动项', '负责人', '截止时间', '状态'],
        rows,
      }),
    ),
  ];
}

function excelRecipe(trustedRoot, recipe, prompt, sources) {
  const parsed = parseTableRows(combinedText(sources));
  const issueCount = parsed.rows.filter((row) => row[row.length - 1] !== '正常').length;
  return [
    markdownOperation(
      trustedRoot,
      recipe.id,
      '表格清洗报告.md',
      [
        '# 表格清洗报告',
        '',
        `- 用户指令: ${prompt || '未填写'}`,
        `- 清洗后行数: ${parsed.rows.length}`,
        `- 需人工确认: ${issueCount}`,
        '',
        '## 来源',
        sourceBlock(sources),
        '',
        '## 规则',
        '- 去除空白行。',
        '- 标记疑似重复行。',
        '- 标记存在空字段的行。',
        '',
      ].join('\n'),
    ),
    xlsxOperation(
      trustedRoot,
      recipe.id,
      '清洗结果.xlsx',
      createXlsxWorkbook({
        sheetName: '清洗结果',
        columns: parsed.columns,
        rows: parsed.rows,
      }),
    ),
  ];
}

function reimbursementRecipe(trustedRoot, recipe, prompt, sources) {
  const rows = reimbursementRows(combinedText(sources));
  return [
    csvOperation(trustedRoot, recipe.id, '报销清单.csv', [['序号', '供应商/项目', '金额', '状态', '来源摘录'], ...rows]),
    markdownOperation(
      trustedRoot,
      recipe.id,
      '报销材料核验.md',
      [
        '# 报销材料核验',
        '',
        `- 用户指令: ${prompt || '未填写'}`,
        `- 条目数: ${rows.length}`,
        '',
        '## 来源',
        sourceBlock(sources),
        '',
        '## 缺失项',
        ...rows.filter((row) => row[3] !== '待核验发票').map((row) => `- ${row[1]}: ${row[3]}`),
        '',
      ].join('\n'),
    ),
  ];
}

export function listRecipes() {
  return RECIPES.map((recipe) => ({ ...recipe }));
}

export function getRecipe(recipeId) {
  return RECIPES.find((recipe) => recipe.id === recipeId) || null;
}

export function buildRecipeOperations({ recipeId, trustedRoot, prompt = '', sources = [] } = {}) {
  const recipe = getRecipe(recipeId);
  if (!recipe) {
    throw new Error(`Unknown recipe: ${recipeId}`);
  }
  if (recipe.id === 'meeting-actions') {
    return meetingRecipe(trustedRoot, recipe, prompt, sources);
  }
  if (recipe.id === 'excel-cleaning') {
    return excelRecipe(trustedRoot, recipe, prompt, sources);
  }
  if (recipe.id === 'reimbursement') {
    return reimbursementRecipe(trustedRoot, recipe, prompt, sources);
  }
  return [markdownOperation(trustedRoot, recipe.id, `${recipe.name}.md`, genericMarkdown(recipe, prompt, sources))];
}
