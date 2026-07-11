// Artifact catalog 只读预览渲染(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:把已经授权、读取后的制品文本与元数据转成无脚本的转义 HTML。
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderArtifactPreviewPage({
  name,
  relativePath,
  size,
  mtime,
  content,
}: {
  name: string;
  relativePath: string;
  size: number;
  mtime: string;
  content: string;
}): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(name)} · Artifact Live Page</title>
    <style>
      :root { color-scheme: light; font-family: "Segoe UI", "Microsoft YaHei", Arial, sans-serif; }
      body { margin: 0; background: #f5f6f2; color: #20211f; }
      main { max-width: 980px; margin: 0 auto; padding: 32px 24px 48px; }
      header { margin-bottom: 20px; }
      h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: 0; }
      .meta { display: flex; flex-wrap: wrap; gap: 8px; color: #646860; font-size: 13px; }
      .meta span { border: 1px solid #d9ded5; background: #fff; border-radius: 8px; padding: 6px 9px; }
      pre { overflow: auto; white-space: pre-wrap; word-break: break-word; background: #fff; border: 1px solid #d9ded5; border-radius: 8px; padding: 18px; line-height: 1.55; font-size: 14px; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Artifact Live Page</h1>
        <div class="meta">
          <span>${escapeHtml(name)}</span>
          <span>${escapeHtml(relativePath)}</span>
          <span>${size} bytes</span>
          <span>${escapeHtml(mtime)}</span>
        </div>
      </header>
      <pre>${escapeHtml(content)}</pre>
    </main>
  </body>
</html>`;
}
