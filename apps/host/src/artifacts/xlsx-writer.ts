// xlsx 文件写出:零依赖手写单 sheet 工作簿(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:把列定义+行数据(数组行或对象行)拼成 SpreadsheetML(OOXML)并打成 .xlsx 包;
//       单元格统一用 inlineStr 内联字符串,文本入 XML 前先转义。
// 依赖:workspace/zip-utils(createZip 打包)
// 导出:createXlsxWorkbook(返回 .xlsx 的 Buffer)
import { createZip } from '../workspace/zip-utils.js';

export type WorkbookRowObject = Record<string, unknown>;
export type WorkbookRow = unknown[] | WorkbookRowObject;
export type WorkbookSpec = {
  sheetName?: unknown;
  columns?: unknown[];
  rows?: WorkbookRow[];
};

/** XML 转义,确保单元格文本安全嵌入 SpreadsheetML。 */
// XML 1.0 非法控制字符(除 \t=9 \n=10 \r=13):0-8、11、12、14-31。源含 NUL/响铃等
// (脏数据/二进制误读)会让 .xlsx 内的 sheet XML 非法,Excel 报「文件损坏无法打开」。
function stripXmlControlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    if (n <= 8 || n === 11 || n === 12 || (n >= 14 && n <= 31)) continue;
    out += ch;
  }
  return out;
}

function escapeXml(value: unknown): string {
  return stripXmlControlChars(String(value ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 把 0 基列序号转成 Excel 列名(0→A、25→Z、26→AA…),26 进制无零。 */
function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** 生成单个单元格 XML:计算 A1 引用并以 inlineStr 内联字符串输出。 */
function cellXml(value: unknown, rowIndex: number, columnIndex: number): string {
  const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
  return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
}

/** 取一行里某列的值:数组行按下标取,对象行按列名取,统一转字符串。 */
function rowValue(row: WorkbookRow, column: unknown, index: number): string {
  if (Array.isArray(row)) {
    return String(row[index] ?? '');
  }
  const record = row && typeof row === 'object' ? row : {};
  return String(record[String(column)] ?? '');
}

/** 生成 worksheet XML:首行写表头,随后逐行写数据;列/行为空时用占位兜底,并算出 dimension 范围。 */
function sheetXml(columns: unknown[], rows: WorkbookRow[]): string {
  const safeColumns = columns.length > 0 ? columns : ['内容'];
  const safeRows: WorkbookRow[] = rows.length > 0 ? rows : [['']];
  const renderedRows = [
    safeColumns.map((column) => String(column ?? '')),
    ...safeRows.map((row) => safeColumns.map((column, index) => rowValue(row, column, index))),
  ];
  const rowXml = renderedRows
    .map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => cellXml(value, rowIndex, columnIndex)).join('')}</row>`)
    .join('');
  const lastColumn = columnName(safeColumns.length - 1);
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<dimension ref="A1:${lastColumn}${renderedRows.length}"/>`,
    '<sheetViews><sheetView workbookViewId="0"/></sheetViews>',
    '<sheetFormatPr defaultRowHeight="15"/>',
    `<sheetData>${rowXml}</sheetData>`,
    '</worksheet>',
  ].join('');
}

/** 由列+行生成最小可打开的 .xlsx;sheet 名截断到 31 字符(Excel 上限),返回 zip 包 Buffer。 */
export function createXlsxWorkbook({ sheetName = 'Sheet1', columns = [], rows = [] }: WorkbookSpec = {}): Buffer {
  const safeSheetName = escapeXml(String(sheetName || 'Sheet1').slice(0, 31));
  return createZip([
    {
      name: '[Content_Types].xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${safeSheetName}" sheetId="1" r:id="rId1"/></sheets>` +
        '</workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/styles.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
        '<borders count="1"><border/></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
        '</styleSheet>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content: sheetXml(columns, rows),
    },
  ]);
}
