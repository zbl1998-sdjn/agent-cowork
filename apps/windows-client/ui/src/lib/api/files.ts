// 文件 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:文件预览与上传——预览返回分类内容(图片/PDF/文本/表格等),并把浏览器 File 编码为 base64 上传载荷。
// 依赖/对应路由:POST /api/files/preview、POST /api/uploads/import。导出:previewFile / importUploads / fileToUpload + FilePreviewResult / UploadFile 类型。
import { postJson } from './transport';

export interface FilePreviewResult {
  kind: 'image' | 'pdf' | 'markdown' | 'text' | 'table' | 'diff' | 'other';
  mime: string;
  name: string;
  size: number;
  base64?: string;
  text?: string;
  table?: { headers: string[]; rows: string[][]; truncated?: boolean };
}

export async function previewFile(path: string, trustedRoot?: string): Promise<FilePreviewResult> {
  return postJson<FilePreviewResult>('/api/files/preview', { path, trustedRoot });
}

export interface UploadFile {
  relativePath: string;
  contentBase64: string;
  size?: number;
}

export async function importUploads(
  files: UploadFile[],
  trustedRoot?: string,
): Promise<{ imported?: Array<{ relativePath?: string; path?: string }> }> {
  return postJson('/api/uploads/import', { files, trustedRoot });
}

export async function fileToUpload(file: File, dir = 'uploads'): Promise<UploadFile> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return { relativePath: `${dir}/${file.name}`, contentBase64: btoa(binary), size: file.size };
}
