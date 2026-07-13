export function composerFileKey(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

export function mergeComposerFiles(current: File[], incoming: File[]): File[] {
  const seen = new Set(current.map(composerFileKey));
  const next = [...current];
  for (const file of incoming) {
    const key = composerFileKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(file);
  }
  return next;
}
