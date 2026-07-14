// 中文 PDF 字体嵌入(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:把一份 TrueType(.ttf)字体做「保 GID 稀疏子集」(只保留用到的字形轮廓,其余置空),
//       并组装成 CIDFontType2 + Identity-H 的 PDF,让中文/CJK 文本在 PDF 中正确显示。
//       基础手写 PDF 引擎用 Helvetica 不含 CJK 字形,本模块是其中文替代路径。
// 依赖:仅 node:fs/zlib(读字体 + FlateDecode 压缩)。导出:createCjkPdfDocument / isCjkFontAvailable。
// 说明:TrueType 大端序;子集保持 GID 不变(loca 仍 numGlyphs+1 项,未用字形零长),
//       PDF 用 CIDToGIDMap=Identity 直接以 GID 编码文本,故字体自身 cmap 不被 PDF 使用。
import fs from 'node:fs'; import zlib from 'node:zlib';
import { readCompatEnv } from '../util/env-compat.js';

const CJK_RE = /[぀-ヿ㐀-鿿-℀-￯豈-﫿]/;
export function hasCjk(text: string): boolean { return CJK_RE.test(String(text || '')); }

type Sfnt = { buf: Buffer; tables: Map<string, { offset: number; length: number }>; numGlyphs: number; unitsPerEm: number; longLoca: boolean; numberOfHMetrics: number };

function readSfnt(buf: Buffer): Sfnt {
  const numTables = buf.readUInt16BE(4);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i += 1) {
    const rec = 12 + i * 16;
    const tag = buf.toString('latin1', rec, rec + 4);
    tables.set(tag, { offset: buf.readUInt32BE(rec + 8), length: buf.readUInt32BE(rec + 12) });
  }
  const head = tables.get('head'); const maxp = tables.get('maxp'); const hhea = tables.get('hhea');
  if (!head || !maxp || !hhea) throw new Error('字体缺少 head/maxp/hhea 表');
  return {
    buf, tables,
    numGlyphs: buf.readUInt16BE(maxp.offset + 4),
    unitsPerEm: buf.readUInt16BE(head.offset + 18),
    longLoca: buf.readInt16BE(head.offset + 50) === 1,
    numberOfHMetrics: buf.readUInt16BE(hhea.offset + 34),
  };
}

/** 解析 cmap:返回 Unicode 码点 → GID 的查表函数(支持 format 4 与 format 12)。 */
function buildCmap(sfnt: Sfnt): (cp: number) => number {
  const cmap = sfnt.tables.get('cmap');
  if (!cmap) return () => 0;
  const b = sfnt.buf; const base = cmap.offset;
  const num = b.readUInt16BE(base + 2);
  let best = -1; let bestScore = -1;
  for (let i = 0; i < num; i += 1) {
    const rec = base + 4 + i * 8;
    const plat = b.readUInt16BE(rec); const enc = b.readUInt16BE(rec + 2);
    const off = b.readUInt32BE(rec + 4);
    // 偏好 (3,10)=Win UCS4 format12 > (3,1)=Win BMP format4 > (0,x)=Unicode
    const score = plat === 3 && enc === 10 ? 4 : plat === 3 && enc === 1 ? 3 : plat === 0 ? 2 : 1;
    if (score > bestScore) { bestScore = score; best = base + off; }
  }
  if (best < 0) return () => 0;
  const format = b.readUInt16BE(best);
  if (format === 12) {
    const nGroups = b.readUInt32BE(best + 12);
    return (cp) => {
      for (let g = 0; g < nGroups; g += 1) {
        const rec = best + 16 + g * 12;
        const start = b.readUInt32BE(rec); const end = b.readUInt32BE(rec + 4);
        if (cp >= start && cp <= end) return b.readUInt32BE(rec + 8) + (cp - start);
      }
      return 0;
    };
  }
  if (format === 4) {
    const segX2 = b.readUInt16BE(best + 6); const segCount = segX2 / 2;
    const endO = best + 14; const startO = endO + segX2 + 2; const deltaO = startO + segX2; const rangeO = deltaO + segX2;
    return (cp) => {
      if (cp > 0xffff) return 0;
      for (let s = 0; s < segCount; s += 1) {
        const end = b.readUInt16BE(endO + s * 2);
        if (cp > end) continue;
        const start = b.readUInt16BE(startO + s * 2);
        if (cp < start) return 0;
        const delta = b.readUInt16BE(deltaO + s * 2); const rangeOff = b.readUInt16BE(rangeO + s * 2);
        if (rangeOff === 0) return (cp + delta) & 0xffff;
        const gidO = rangeO + s * 2 + rangeOff + (cp - start) * 2;
        const gid = b.readUInt16BE(gidO);
        return gid === 0 ? 0 : (gid + delta) & 0xffff;
      }
      return 0;
    };
  }
  return () => 0;
}

function readLoca(sfnt: Sfnt): number[] {
  const loca = sfnt.tables.get('loca'); if (!loca) throw new Error('缺 loca');
  const b = sfnt.buf; const out: number[] = []; const n = sfnt.numGlyphs + 1;
  for (let i = 0; i < n; i += 1) out.push(sfnt.longLoca ? b.readUInt32BE(loca.offset + i * 4) : b.readUInt16BE(loca.offset + i * 2) * 2);
  return out;
}

// 复合字形会引用其它 GID(flags bit0=ARG_1_AND_2_ARE_WORDS, bit5=MORE_COMPONENTS)。递归收集。
function collectComponents(sfnt: Sfnt, loca: number[], gid: number, glyfOff: number, into: Set<number>): void {
  const start = loca[gid] ?? 0; const end = loca[gid + 1] ?? 0;
  if (end <= start) return;
  const b = sfnt.buf; const p0 = glyfOff + start;
  if (b.readInt16BE(p0) >= 0) return; // numberOfContours>=0 → 简单字形
  let p = p0 + 10;
  for (;;) {
    const flags = b.readUInt16BE(p); const comp = b.readUInt16BE(p + 2);
    if (!into.has(comp)) { into.add(comp); collectComponents(sfnt, loca, comp, glyfOff, into); }
    p += 4 + (flags & 0x0001 ? 4 : 2) + (flags & 0x0008 ? 2 : flags & 0x0040 ? 4 : flags & 0x0080 ? 8 : 0);
    if (!(flags & 0x0020)) break;
  }
}

function pad4(buf: Buffer): Buffer { const r = buf.length % 4; return r ? Buffer.concat([buf, Buffer.alloc(4 - r)]) : buf; }
function tableChecksum(buf: Buffer): number { let sum = 0; const padded = pad4(buf); for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0; return sum >>> 0; }

/** 保 GID 稀疏子集:仅保留 usedGids 的 glyf,重建 loca/glyf,其余表原样。返回新 sfnt 字节。 */
function subsetFont(sfnt: Sfnt, usedGids: Set<number>): Buffer {
  const loca = readLoca(sfnt);
  const glyf = sfnt.tables.get('glyf'); if (!glyf) throw new Error('缺 glyf');
  const closure = new Set<number>([0, ...usedGids]);
  for (const g of [...closure]) collectComponents(sfnt, loca, g, glyf.offset, closure);
  // 重建 glyf + loca(long 格式统一)
  const newLoca: number[] = [0]; const parts: Buffer[] = [];
  let acc = 0;
  for (let gid = 0; gid < sfnt.numGlyphs; gid += 1) {
    const gs = loca[gid] ?? 0; const ge = loca[gid + 1] ?? 0;
    if (closure.has(gid) && ge > gs) {
      let g = sfnt.buf.subarray(glyf.offset + gs, glyf.offset + ge);
      if (g.length % 2) g = Buffer.concat([g, Buffer.alloc(1)]); // glyf 需偶数对齐
      parts.push(g); acc += g.length;
    }
    newLoca.push(acc);
  }
  const newGlyf = Buffer.concat(parts);
  const locaBuf = Buffer.alloc((sfnt.numGlyphs + 1) * 4);
  newLoca.forEach((v, i) => locaBuf.writeUInt32BE(v, i * 4));
  // head.indexToLocFormat=1(long);checkSumAdjustment=0
  const headSrc = sfnt.tables.get('head');
  if (!headSrc) throw new Error('缺 head');
  const headBuf = Buffer.from(sfnt.buf.subarray(headSrc.offset, headSrc.offset + headSrc.length));
  headBuf.writeUInt32BE(0, 8); headBuf.writeInt16BE(1, 50);

  const keepTags = ['head', 'hhea', 'maxp', 'OS/2', 'hmtx', 'cmap', 'name', 'post', 'cvt ', 'fpgm', 'prep'];
  const outTables = new Map<string, Buffer>();
  for (const tag of keepTags) {
    if (tag === 'head') { outTables.set('head', headBuf); continue; }
    const t = sfnt.tables.get(tag);
    if (t) outTables.set(tag, Buffer.from(sfnt.buf.subarray(t.offset, t.offset + t.length)));
  }
  outTables.set('loca', locaBuf);
  outTables.set('glyf', newGlyf);

  const tags = [...outTables.keys()].sort();
  const numTables = tags.length;
  const headerLen = 12 + numTables * 16;
  let offset = headerLen;
  const records: { tag: string; checksum: number; offset: number; length: number }[] = [];
  const bodies: Buffer[] = [];
  for (const tag of tags) {
    const body = outTables.get(tag) ?? Buffer.alloc(0);
    records.push({ tag, checksum: tableChecksum(body), offset, length: body.length });
    const padded = pad4(body); bodies.push(padded); offset += padded.length;
  }
  const header = Buffer.alloc(headerLen);
  header.writeUInt32BE(0x00010000, 0); header.writeUInt16BE(numTables, 4);
  const es = Math.floor(Math.log2(numTables)); const sr = Math.pow(2, es) * 16;
  header.writeUInt16BE(sr, 6); header.writeUInt16BE(es, 8); header.writeUInt16BE(numTables * 16 - sr, 10);
  records.forEach((r, i) => {
    const p = 12 + i * 16;
    header.write(r.tag, p, 'latin1'); header.writeUInt32BE(r.checksum, p + 4);
    header.writeUInt32BE(r.offset, p + 8); header.writeUInt32BE(r.length, p + 12);
  });
  return Buffer.concat([header, ...bodies]);
}

function readHmtxAdvance(sfnt: Sfnt, gid: number): number {
  const hmtx = sfnt.tables.get('hmtx'); if (!hmtx) return sfnt.unitsPerEm;
  const idx = Math.min(gid, sfnt.numberOfHMetrics - 1);
  return sfnt.buf.readUInt16BE(hmtx.offset + idx * 4);
}

let cachedFontPath: string | null | undefined;
/** 找一份可嵌入的 CJK .ttf(env ACW_CJK_FONT 优先,否则系统黑体/等线)。找不到返回 null。 */
export function resolveCjkFontPath(env: Record<string, string | undefined> = process.env): string | null {
  if (cachedFontPath !== undefined) return cachedFontPath;
  const candidates = [readCompatEnv(env, 'ACW_CJK_FONT', 'KCW_CJK_FONT'), 'C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/Deng.ttf', 'C:/Windows/Fonts/simkai.ttf', '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc'].filter(Boolean) as string[];
  cachedFontPath = candidates.find((p) => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } }) || null;
  return cachedFontPath;
}
export function isCjkFontAvailable(env: Record<string, string | undefined> = process.env): boolean { return resolveCjkFontPath(env) !== null; }

function pdfEscapeName(s: string): string { return s.replace(/[^A-Za-z0-9]/g, ''); }

/** 用嵌入的 CJK 字体生成一份多行 PDF(标题 + 行文本),中文正确显示。字体不可用时返回 null。 */
export function createCjkPdfDocument(spec: { title?: string; lines?: string[] } = {}, env: Record<string, string | undefined> = process.env): Buffer | null {
  const fontPath = resolveCjkFontPath(env);
  if (!fontPath) return null;
  const title = spec.title || 'PDF';
  const lines = [title, ...(spec.lines || [])].map((l) => String(l ?? '')).filter((l) => l.length > 0).slice(0, 45);
  const fontBuf = fs.readFileSync(fontPath);
  const sfnt = readSfnt(fontBuf);
  const cmap = buildCmap(sfnt);
  // 收集用到的字符 → GID
  const usedGids = new Set<number>(); const charToGid = new Map<number, number>();
  for (const line of lines) for (const ch of line) {
    const cp = ch.codePointAt(0) ?? 0; if (charToGid.has(cp)) continue;
    const gid = cmap(cp); charToGid.set(cp, gid); if (gid) usedGids.add(gid);
  }
  const subset = subsetFont(sfnt, usedGids);
  const subsetZ = zlib.deflateSync(subset);
  const scale = 1000 / sfnt.unitsPerEm;
  // 内容流:每行一个 hex GID 串
  const fontSize = 14; const lineGap = 22; const top = 800; const left = 60;
  const streamParts: string[] = [];
  lines.forEach((line, i) => {
    let hex = '';
    for (const ch of line) { const gid = charToGid.get(ch.codePointAt(0) ?? 0) || 0; hex += gid.toString(16).padStart(4, '0'); }
    streamParts.push(`BT /F1 ${fontSize} Tf ${left} ${top - i * lineGap} Td <${hex}> Tj ET`);
  });
  const content = streamParts.join('\n');
  // W 数组(用到的 GID 宽度,单位 1000/em)
  const wEntries = [...usedGids].sort((a, b) => a - b).map((gid) => `${gid}[${Math.round(readHmtxAdvance(sfnt, gid) * scale)}]`).join(' ');
  const fontName = `AGCJK+${pdfEscapeName(fontPath.split(/[\\/]/).pop() || 'CJK')}`;

  // 组装 PDF 对象(1..8)
  const objs: (string | Buffer)[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>';
  objs[4] = `<< /Type /Font /Subtype /Type0 /BaseFont /${fontName} /Encoding /Identity-H /DescendantFonts [6 0 R] >>`;
  objs[5] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  objs[6] = `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${fontName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /CIDToGIDMap /Identity /DW 1000 /W [${wEntries}] >>`;
  objs[7] = `<< /Type /FontDescriptor /FontName /${fontName} /Flags 4 /FontBBox [0 -250 1100 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 /FontFile2 8 0 R >>`;
  const ff2Header = Buffer.from(`<< /Length ${subsetZ.length} /Length1 ${subset.length} /Filter /FlateDecode >>\nstream\n`, 'latin1');
  objs[8] = Buffer.concat([ff2Header, subsetZ, Buffer.from('\nendstream', 'latin1')]);

  const header = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const chunks: Buffer[] = [header];
  const offsets: number[] = [0];
  let pos = header.length;
  for (let i = 1; i <= 8; i += 1) {
    offsets[i] = pos;
    const head = Buffer.from(`${i} 0 obj\n`, 'latin1');
    const body = Buffer.isBuffer(objs[i]) ? objs[i] as Buffer : Buffer.from(objs[i] as string, 'latin1');
    const tail = Buffer.from('\nendobj\n', 'latin1');
    chunks.push(head, body, tail); pos += head.length + body.length + tail.length;
  }
  const xrefPos = pos;
  let xref = `xref\n0 9\n0000000000 65535 f \n`;
  for (let i = 1; i <= 8; i += 1) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}
