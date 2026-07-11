// 文件尺寸债务棘轮的纯策略层(scripts · 门禁策略)
// ---------------------------------------------------------------------------
// 职责:校验静态 baseline,并判定源码行数是否新增超限、突破既有 no-growth 上限、
//   留下失效 baseline,或越过绝对硬上限。文件遍历与 CLI 输出留在 check-filesize.ts。
// 依赖:无外部依赖,供真实门禁与契约测试共用。

export const FILE_SIZE_SOFT_LIMIT = 250;
export const FILE_SIZE_HARD_LIMIT = 400;

export type FileSizeBaselineEntry = {
  maxLines: number;
};

export type FileSizeBaseline = {
  schemaVersion: 1;
  softLimit: typeof FILE_SIZE_SOFT_LIMIT;
  hardLimit: typeof FILE_SIZE_HARD_LIMIT;
  files: Record<string, FileSizeBaselineEntry>;
};

export type FileSizePolicyResult = {
  warnings: string[];
  failures: string[];
};

type EvaluateFileSizePolicyOptions = {
  baseline: FileSizeBaseline;
  files: ReadonlyMap<string, number>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNormalizedRepoPath(value: string): boolean {
  return value.length > 0
    && !value.includes('\\')
    && !value.startsWith('/')
    && !/^[A-Za-z]:/.test(value)
    && !value.split('/').includes('..');
}

export function parseFileSizeBaseline(value: unknown): FileSizeBaseline {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('filesize baseline must be an object with schemaVersion 1');
  }
  if (value.softLimit !== FILE_SIZE_SOFT_LIMIT || value.hardLimit !== FILE_SIZE_HARD_LIMIT) {
    throw new Error(
      `filesize baseline limits must remain ${FILE_SIZE_SOFT_LIMIT}/${FILE_SIZE_HARD_LIMIT}`,
    );
  }
  if (!isRecord(value.files)) {
    throw new Error('filesize baseline files must be an object');
  }

  const files: Record<string, FileSizeBaselineEntry> = {};
  for (const [filePath, rawEntry] of Object.entries(value.files)) {
    if (!isNormalizedRepoPath(filePath)) {
      throw new Error(`filesize baseline path must be a normalized repo-relative path: ${filePath}`);
    }
    if (
      !isRecord(rawEntry)
      || !Number.isInteger(rawEntry.maxLines)
      || Number(rawEntry.maxLines) <= FILE_SIZE_SOFT_LIMIT
      || Number(rawEntry.maxLines) > FILE_SIZE_HARD_LIMIT
    ) {
      throw new Error(
        `filesize baseline maxLines must be an integer above ${FILE_SIZE_SOFT_LIMIT} `
        + `and at most ${FILE_SIZE_HARD_LIMIT}: ${filePath}`,
      );
    }
    files[filePath] = { maxLines: Number(rawEntry.maxLines) };
  }

  return {
    schemaVersion: 1,
    softLimit: FILE_SIZE_SOFT_LIMIT,
    hardLimit: FILE_SIZE_HARD_LIMIT,
    files,
  };
}

export function evaluateFileSizePolicy(options: EvaluateFileSizePolicyOptions): FileSizePolicyResult {
  const warnings: string[] = [];
  const failures: string[] = [];
  const sortedFiles = [...options.files.entries()].sort(([left], [right]) => left.localeCompare(right));

  for (const [filePath, lines] of sortedFiles) {
    const baselineEntry = options.baseline.files[filePath];

    if (!Number.isInteger(lines) || lines < 0) {
      failures.push(`${filePath}: invalid line count ${lines}`);
      continue;
    }
    if (lines > FILE_SIZE_HARD_LIMIT) {
      failures.push(`${filePath}: ${lines} lines exceeds hard limit (${FILE_SIZE_HARD_LIMIT})`);
      continue;
    }
    if (lines <= FILE_SIZE_SOFT_LIMIT) continue;
    if (!baselineEntry) {
      failures.push(
        `${filePath}: ${lines} lines exceeds soft limit (${FILE_SIZE_SOFT_LIMIT}); no baseline entry`,
      );
      continue;
    }
    if (lines > baselineEntry.maxLines) {
      failures.push(
        `${filePath}: ${lines} lines exceeds no-growth baseline (${baselineEntry.maxLines})`,
      );
      continue;
    }
    if (lines < baselineEntry.maxLines) {
      failures.push(
        `${filePath}: baseline must be tightened from ${baselineEntry.maxLines} to ${lines} `
        + 'to lock in the size reduction',
      );
      continue;
    }

    warnings.push(
      `${filePath}: ${lines} lines over soft limit (${FILE_SIZE_SOFT_LIMIT}); `
      + `no-growth baseline ${baselineEntry.maxLines}`,
    );
  }

  for (const filePath of Object.keys(options.baseline.files).sort()) {
    const lines = options.files.get(filePath);
    if (lines == null) {
      failures.push(`${filePath}: stale baseline entry; source file is missing`);
    } else if (lines <= FILE_SIZE_SOFT_LIMIT) {
      failures.push(
        `${filePath}: stale baseline entry; ${lines} lines is no longer over soft limit `
        + `(${FILE_SIZE_SOFT_LIMIT})`,
      );
    }
  }

  return { warnings, failures };
}
