// @ts-check
//
// 列/数据集描述统计(host · L1 领域层 · tools/data)
// ---------------------------------------------------------------------------
// 职责:把表格数据转成描述性统计(计数/缺失/去重/类型推断,数值列另算 min/max/mean/median/总体
//       stddev,非数值列取 Top 值)。补充 profile.js,服务于数据分析闭环。纯函数、无上行依赖、可测。
// 导出:computeColumnStats(单列) / describeRows(整表)。
//
// Column / dataset descriptive statistics (05-A4).
//
// Pure helpers that turn tabular data into descriptive stats for the data
// analysis closure (profile -> stats -> chart -> report). Complements
// profile.js. Layer L1 (tools), no upward imports, deterministic & testable.
// stddev is the population standard deviation.

/**
 * @typedef {'empty' | 'number' | 'boolean' | 'string'} ColumnStatsType
 * @typedef {{ min: number, max: number, sum: number, mean: number, median: number, stddev: number }} ColumnNumericStats
 * @typedef {{ value: string, count: number }} ColumnTopValue
 * @typedef {{ count: number, nulls: number, distinct: number, type: ColumnStatsType, numeric: ColumnNumericStats | null, top: ColumnTopValue[] }} ColumnStats
 * @typedef {{ rowCount: number, columns: Record<string, ColumnStats> }} RowStats
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isEmpty(value) {
  return value === null || value === undefined || value === '';
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'boolean') {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return null;
    }
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isBooleanish(value) {
  if (typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'string') {
    return ['true', 'false'].includes(value.trim().toLowerCase());
  }
  return false;
}

/**
 * 计算单列统计:推断类型;数值列出 min/max/sum/mean/median/stddev,其余出 Top5 高频值。
 * @param {unknown[] | undefined} values
 * @returns {ColumnStats}
 */
export function computeColumnStats(values = []) {
  const all = Array.isArray(values) ? values : [];
  const count = all.length;
  const nonEmpty = all.filter((value) => !isEmpty(value));
  const nulls = count - nonEmpty.length;
  const distinct = new Set(nonEmpty.map((value) => String(value))).size;

  /** @type {ColumnStatsType} */
  let type = 'string';
  if (nonEmpty.length === 0) {
    type = 'empty';
  } else if (nonEmpty.every((value) => toNumber(value) !== null)) {
    type = 'number';
  } else if (nonEmpty.every((value) => isBooleanish(value))) {
    type = 'boolean';
  }

  /** @type {ColumnStats} */
  const stats = { count, nulls, distinct, type, numeric: null, top: [] };

  if (type === 'number') {
    const nums = nonEmpty.map((value) => toNumber(value)).filter((value) => value !== null).sort((a, b) => a - b);
    const n = nums.length;
    const sum = nums.reduce((acc, x) => acc + x, 0);
    const mean = sum / n;
    const median = n % 2 ? nums[(n - 1) / 2] : (nums[n / 2 - 1] + nums[n / 2]) / 2;
    const variance = nums.reduce((acc, x) => acc + (x - mean) ** 2, 0) / n;
    stats.numeric = {
      min: nums[0],
      max: nums[n - 1],
      sum,
      mean,
      median,
      stddev: Math.sqrt(variance),
    };
  } else if (type !== 'empty') {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const value of nonEmpty) {
      const key = String(value);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    stats.top = [...counts.entries()]
      .map(([value, c]) => ({ value, count: c }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
      .slice(0, 5);
  }

  return stats;
}

/**
 * 描述整张「对象数组」表:汇总所有列名,逐列调用 computeColumnStats。
 * @param {unknown[] | undefined} rows
 * @returns {RowStats}
 */
export function describeRows(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const columnNames = [];
  const seen = new Set();
  for (const row of list) {
    if (isRecord(row)) {
      for (const key of Object.keys(row)) {
        if (!seen.has(key)) {
          seen.add(key);
          columnNames.push(key);
        }
      }
    }
  }

  /** @type {Record<string, ColumnStats>} */
  const columns = {};
  for (const name of columnNames) {
    columns[name] = computeColumnStats(
      list.map((row) => (isRecord(row) ? row[name] : undefined)),
    );
  }

  return { rowCount: list.length, columns };
}
