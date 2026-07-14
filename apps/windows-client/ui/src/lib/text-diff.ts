// text-diff(UI · lib 纯逻辑层)
// ---------------------------------------------------------------------------
// 职责:对两段文本做逐行 LCS diff,供审批卡片渲染 +/- 标记的可读 diff。
//       行数乘积超过安全上限时返回 null,调用方回退到整块 before/after 展示,
//       避免超大文本在浏览器里跑 O(N*M) 动态规划卡死。纯函数,无副作用。

export type DiffLine = { type: 'same' | 'add' | 'remove'; text: string };

const MAX_DIFF_CELLS = 200_000;

function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

export function computeLineDiff(before: string, after: string): DiffLine[] | null {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length * b.length > MAX_DIFF_CELLS) return null;

  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[] = new Array(rows * cols).fill(0);
  const at = (i: number, j: number): number => dp[i * cols + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * cols + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lineA = a[i] as string;
    const lineB = b[j] as string;
    if (lineA === lineB) {
      result.push({ type: 'same', text: lineA });
      i++; j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      result.push({ type: 'remove', text: lineA });
      i++;
    } else {
      result.push({ type: 'add', text: lineB });
      j++;
    }
  }
  while (i < a.length) { result.push({ type: 'remove', text: a[i] as string }); i++; }
  while (j < b.length) { result.push({ type: 'add', text: b[j] as string }); j++; }
  return result;
}
