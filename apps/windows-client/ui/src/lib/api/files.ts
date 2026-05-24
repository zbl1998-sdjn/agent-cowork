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
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return { relativePath: `${dir}/${file.name}`, contentBase64: btoa(binary), size: file.size };
}
