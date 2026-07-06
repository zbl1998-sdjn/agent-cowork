import { describe, expect, it } from 'vitest';
import { artifactFriendlyKind, artifactMeta, humanArtifactSize, sanitizeArtifactRename } from './ArtifactsPanel';

describe('ArtifactsPanel helpers', () => {
  it('formats artifact size and metadata for card display', () => {
    // artifact 卡片要用稳定的人类可读大小和类型摘要,方便用户快速扫视产物。
    expect(humanArtifactSize(42)).toBe('42 B');
    expect(humanArtifactSize(1536)).toBe('1.5 KB');
    expect(artifactMeta({ path: 'C:/work/a.md', name: 'a.md', kind: 'markdown', size: 2048 })).toBe('草稿文本 · 2.0 KB');
    expect(artifactFriendlyKind({ path: 'C:/work/a.docx', name: 'a.docx', kind: 'file' })).toBe('Word');
    expect(artifactFriendlyKind({ path: 'C:/work/a.xlsx', name: 'a.xlsx', kind: 'file' })).toBe('Excel');
    expect(artifactFriendlyKind({ path: 'C:/work/a.pptx', name: 'a.pptx', kind: 'file' })).toBe('PPT');
    expect(artifactFriendlyKind({ path: 'C:/work/a.pdf', name: 'a.pdf', kind: 'file' })).toBe('PDF');
    expect(artifactFriendlyKind({ path: 'C:/work/a.csv', name: 'a.csv', kind: 'file' })).toBe('CSV 表格');
  });

  it('accepts file names and rejects path-like rename input', () => {
    // 重命名只接受纯文件名,显式拒绝 ../ 或 nested/file.md 这类路径逃逸输入。
    expect(sanitizeArtifactRename(' report-final.md ')).toBe('report-final.md');
    expect(sanitizeArtifactRename('../escape.md')).toBe('');
    expect(sanitizeArtifactRename('nested/file.md')).toBe('');
    expect(sanitizeArtifactRename('')).toBe('');
  });
});
