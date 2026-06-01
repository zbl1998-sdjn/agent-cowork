import assert from 'node:assert/strict';
import test from 'node:test';
import { computeColumnStats, describeRows } from '../src/tools/data/statistics.js';
import type { ColumnNumericStats, ColumnStats, RowStats } from '../src/tools/data/statistics.js';

function requireNumeric(stats: ColumnStats): ColumnNumericStats {
  assert.ok(stats.numeric, 'numeric stats should be present');
  return stats.numeric;
}

function requireColumn(stats: RowStats, name: string): ColumnStats {
  const column = stats.columns[name];
  assert.ok(column, `column ${name} should be present`);
  return column;
}

test('numeric column: min/max/sum/mean/median/stddev', () => {
  const s = computeColumnStats([1, 2, 3, 4]);
  const numeric = requireNumeric(s);
  assert.equal(s.type, 'number');
  assert.equal(s.count, 4);
  assert.equal(s.nulls, 0);
  assert.equal(s.distinct, 4);
  assert.equal(numeric.min, 1);
  assert.equal(numeric.max, 4);
  assert.equal(numeric.sum, 10);
  assert.equal(numeric.mean, 2.5);
  assert.equal(numeric.median, 2.5);
  assert.ok(Math.abs(numeric.stddev - Math.sqrt(1.25)) < 1e-9);
});

test('odd-length median is the middle value', () => {
  const s = computeColumnStats([5, 1, 3]);
  assert.equal(requireNumeric(s).median, 3);
});

test('counts empty values as nulls and excludes them from stats', () => {
  const s = computeColumnStats([1, '', 3, null, undefined]);
  assert.equal(s.count, 5);
  assert.equal(s.nulls, 3);
  assert.equal(s.type, 'number');
  assert.equal(requireNumeric(s).mean, 2);
});

test('numeric strings are treated as numbers', () => {
  const s = computeColumnStats(['1', '2', '3']);
  assert.equal(s.type, 'number');
  assert.equal(requireNumeric(s).sum, 6);
});

test('string column: distinct + top values ordered by count then value', () => {
  const s = computeColumnStats(['a', 'b', 'a', 'c', 'a', 'b']);
  assert.equal(s.type, 'string');
  assert.equal(s.distinct, 3);
  assert.deepEqual(s.top[0], { value: 'a', count: 3 });
  assert.deepEqual(s.top[1], { value: 'b', count: 2 });
  assert.deepEqual(s.top[2], { value: 'c', count: 1 });
});

test('boolean column is detected', () => {
  const s = computeColumnStats([true, false, true]);
  assert.equal(s.type, 'boolean');
  assert.equal(s.distinct, 2);
});

test('empty column reports type empty', () => {
  const s = computeColumnStats([]);
  assert.equal(s.type, 'empty');
  assert.equal(s.count, 0);
  assert.equal(s.numeric, null);
});

test('describeRows profiles each column of array-of-objects', () => {
  const out = describeRows([
    { age: 30, city: '北京' },
    { age: 40, city: '上海' },
    { age: 50, city: '北京' },
  ]);
  assert.equal(out.rowCount, 3);
  const age = requireColumn(out, 'age');
  assert.equal(age.type, 'number');
  assert.equal(requireNumeric(age).mean, 40);
  const city = requireColumn(out, 'city');
  assert.equal(city.type, 'string');
  assert.equal(city.distinct, 2);
  assert.deepEqual(city.top[0], { value: '北京', count: 2 });
});
