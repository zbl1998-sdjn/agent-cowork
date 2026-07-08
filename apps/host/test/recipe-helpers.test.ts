import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  actionRows,
  binaryOperation,
  combinedText,
  csvOperation,
  markdownOperation,
  parseTableRows,
  reimbursementRows,
  relSource,
  sourceBlock,
  xlsxOperation,
} from '../src/recipes/recipe-helpers.js';

const root = path.resolve('C:/workspace');

test('recipe helpers describe and combine source material without inventing content', () => {
  assert.equal(relSource({ relativePath: 'docs/a.md', path: 'ignored.md' }), 'docs/a.md');
  assert.equal(relSource({}), 'unknown');
  assert.equal(sourceBlock([]), '- 未提供可读取来源文件');
  assert.equal(sourceBlock([
    { relativePath: 'docs/a.md', kind: 'markdown' },
    { path: 'C:/workspace/b.pdf', error: '无法读取' },
  ]), [
    '- docs/a.md (markdown)',
    '- C:/workspace/b.pdf: 无法读取',
  ].join('\n'));

  const text = combinedText([
    { relativePath: 'a.txt', content: 'alpha' },
    { relativePath: 'empty.txt', content: '' },
    { relativePath: 'b.txt', content: 'b'.repeat(21000) },
  ]);
  assert.match(text, /^## a\.txt\nalpha\n\n## b\.txt\n/);
  assert.equal(text.length, 20000);
});

test('recipe helpers build write operations with safe artifact paths and encodings', () => {
  const markdown = markdownOperation(root, 'summary', 'report.md', '# Report');
  assert.equal(markdown.type, 'write');
  assert.equal(markdown.content, '# Report');
  assert.ok(markdown.path);
  assert.match(markdown.path, /[\\/]\.AgentCowork[\\/]artifacts[\\/]summary-\d{14}-[a-f0-9]{4}-report\.md$/);

  const csv = csvOperation(root, 'table', 'rows.csv', [
    ['name', 'note'],
    ['ACME', 'needs, "quote"\nline'],
    [null, ''],
  ]);
  assert.equal(csv.content, 'name,note\nACME,"needs, ""quote""\nline"\n,\n');

  const binary = binaryOperation(root, 'bin', 'payload.bin', Buffer.from('hello'));
  assert.equal(binary.encoding, 'base64');
  assert.equal(binary.contentBase64, Buffer.from('hello').toString('base64'));

  const workbook = xlsxOperation(root, 'xlsx', 'book.xlsx', Buffer.from('xlsx'));
  assert.equal(workbook.encoding, 'base64');
  assert.equal(workbook.contentBase64, Buffer.from('xlsx').toString('base64'));
});

test('csvOperation neutralizes formula/DDE injection but keeps plain numbers', () => {
  const csv = csvOperation(root, 'sec', 'inj.csv', [
    ['col'],
    ['=HYPERLINK("http://evil","x")'], // = 公式 → 前置 '
    ["=cmd|'/c calc'!A1"],             // DDE → 前置 '
    ['+1+1'],                          // 非纯数字的 + → 前置 '
    ['@SUM(1)'],                       // @ → 前置 '
    ['-5'],                            // 合法负数 → 保持
    ['+3.2'],                          // 合法正数 → 保持
    ['1200'],                          // 普通数 → 保持
    ['正常文本'],
  ]);
  const lines = String(csv.content).split('\n');
  const at = (i: number): string => lines[i] ?? '';
  assert.ok(at(1).startsWith('"\'=HYPERLINK') || at(1).startsWith("'=HYPERLINK"), '= 公式必须前置单引号');
  assert.ok(at(2).startsWith("'=cmd"), 'DDE 必须前置单引号');
  assert.ok(at(3).startsWith("'+1+1"), '非数字 + 必须中和');
  assert.ok(at(4).startsWith("'@SUM"), '@ 必须中和');
  assert.equal(at(5), '-5');       // 合法负数不误伤
  assert.equal(at(6), '+3.2');     // 合法正数不误伤
  assert.equal(at(7), '1200');
  assert.equal(at(8), '正常文本');
});

test('parseTableRows normalizes headers, duplicates, and empty fields', () => {
  assert.deepEqual(parseTableRows('').rows, [['1', '未发现可解析表格行', '需人工确认']]);

  const parsed = parseTableRows([
    'name,amount',
    'Alice,10',
    'Alice,10',
    'Bob,',
  ].join('\n'));

  assert.deepEqual(parsed.columns, ['行号', 'name', 'amount', '清洗状态']);
  assert.deepEqual(parsed.rows, [
    ['1', 'Alice', '10', '正常'],
    ['2', 'Alice', '10', '疑似重复'],
    ['3', 'Bob', '', '存在空字段'],
  ]);

  const oneColumn = parseTableRows('only value');
  assert.deepEqual(oneColumn.columns, ['行号', '列1', '清洗状态']);
  assert.deepEqual(oneColumn.rows, [['1', 'only value', '正常']]);
});

test('actionRows extracts accountable follow-up rows and falls back to prompt', () => {
  const rows = actionRows([
    '1. 待办：负责人:张三 2026-06-30 完成合同确认',
    '普通描述行',
    '- TODO 准备发布材料 6月25日',
  ].join('\n'), '备用提示');

  assert.deepEqual(rows[0], ['1', '待办：负责人:张三 2026-06-30 完成合同确认', '张三', '2026-06-30', '未开始']);
  assert.deepEqual(rows[1], ['2', 'TODO 准备发布材料 6月25日', '待确认', '6月25日', '未开始']);

  assert.deepEqual(actionRows('没有匹配的普通文本', '根据会议整理行动项'), [
    ['1', '根据会议整理行动项', '待确认', '待确认', '未开始'],
  ]);
});

test('reimbursementRows extracts vendor and amount while preserving a fail-closed fallback', () => {
  assert.deepEqual(reimbursementRows([
    'ACME, 发票 金额 ¥123.45',
    '普通描述',
    'Taxi invoice amount 88',
  ].join('\n')), [
    ['1', 'ACME', '123.45', '待核验发票', 'ACME, 发票 金额 ¥123.45'],
    ['3', 'Taxi invoice amount 88', '88', '待核验发票', 'Taxi invoice amount 88'],
  ]);

  assert.deepEqual(reimbursementRows('没有可识别条目'), [
    ['1', '待确认供应商', '', '缺少金额', '未从来源中识别到明确报销条目'],
  ]);
});
