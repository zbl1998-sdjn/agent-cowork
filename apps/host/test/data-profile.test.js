import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createAgentTools } from '../src/kimi/agent-tools.js';
import { createBuiltinTools } from '../src/tools/builtin-tools.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { analyzeDataFile } from '../src/tools/data/report.js';
import { profileDataFile } from '../src/tools/data/profile.js';
import { makeTestWorkspace } from './test-fixtures.js';

function workspace() {
  return makeTestWorkspace('kcw-data-profile');
}

test('profiles CSV columns with numeric stats and chart suggestions', () => {
  const trustedRoot = workspace();
  fs.writeFileSync(
    path.join(trustedRoot, 'sales.csv'),
    [
      'date,region,revenue,units',
      '2026-01-01,North,10.5,2',
      '2026-01-02,South,20,4',
      '2026-01-03,North,31,',
    ].join('\n'),
    'utf8',
  );

  const profile = profileDataFile({ trustedRoot, path: 'sales.csv' });

  assert.equal(profile.kind, 'data-profile');
  assert.equal(profile.rowCount, 3);
  assert.equal(profile.sampledRows, 3);
  assert.equal(profile.columns.length, 4);
  assert.equal(profile.columns.find((column) => column.name === 'date').type, 'date');
  const region = profile.columns.find((column) => column.name === 'region');
  assert.equal(region.type, 'text');
  assert.deepEqual(region.topValues[0], { value: 'North', count: 2 });
  const revenue = profile.columns.find((column) => column.name === 'revenue');
  assert.equal(revenue.type, 'number');
  assert.equal(revenue.numeric.min, 10.5);
  assert.equal(revenue.numeric.max, 31);
  assert.equal(revenue.numeric.mean, 20.5);
  assert.equal(profile.columns.find((column) => column.name === 'units').empty, 1);
  assert.ok(profile.chartSuggestions.some((suggestion) => suggestion.type === 'bar'));
  assert.match(profile.report, /sales\.csv: 3 rows, 4 columns/);
});

test('profiles TSV and caps sampled rows', () => {
  const trustedRoot = workspace();
  fs.writeFileSync(path.join(trustedRoot, 'events.tsv'), 'name\tcount\na\t1\nb\t2\nc\t3\n', 'utf8');

  const profile = profileDataFile({ trustedRoot, path: 'events.tsv', maxRows: 2 });

  assert.equal(profile.delimiter, 'tab');
  assert.equal(profile.rowCount, 3);
  assert.equal(profile.sampledRows, 2);
  assert.equal(profile.truncated, true);
});

test('rejects data profiling outside the trusted root', () => {
  const trustedRoot = workspace();
  assert.throws(() => profileDataFile({ trustedRoot, path: '../outside.csv' }), /outside|escaped|Sensitive/i);
});

test('data profile is exposed as safe builtin and agent tool', async () => {
  const trustedRoot = workspace();
  fs.writeFileSync(path.join(trustedRoot, 'data.csv'), 'name,value\na,1\n', 'utf8');

  const registry = new ToolRegistry().registerMany(createBuiltinTools({ sandbox: null }));
  const builtin = await registry.call('data.profile', { path: 'data.csv' }, { trustedRoot });
  assert.equal(builtin.columns.find((column) => column.name === 'value').type, 'number');

  const agentTool = createAgentTools({ trustedRoot }).find((tool) => tool.name === 'AnalyzeDataFile');
  assert.equal(agentTool?.mutating, false);
  assert.equal(agentTool?.risk, 'safe');
  const agentResult = await agentTool.handler({ path: 'data.csv' });
  assert.equal(agentResult.rowCount, 1);
  assert.equal(agentResult.kind, 'data-analysis');
  assert.match(agentResult.reportMarkdown, /# Data analysis: data\.csv/);
});

test('data analysis builds a chart spec and markdown report', async () => {
  const trustedRoot = workspace();
  fs.writeFileSync(
    path.join(trustedRoot, 'sales.csv'),
    [
      'region,revenue',
      'North,10',
      'South,15',
      'North,5',
    ].join('\n'),
    'utf8',
  );

  const analysis = analyzeDataFile({ trustedRoot, path: 'sales.csv' });

  assert.equal(analysis.kind, 'data-analysis');
  assert.equal(analysis.rowCount, 3);
  assert.equal(analysis.columnCount, 2);
  assert.equal(analysis.chart.kind, 'bar');
  assert.deepEqual(analysis.chart.data.labels, ['North', 'South']);
  assert.deepEqual(analysis.chart.data.values, [15, 15]);
  assert.match(analysis.reportMarkdown, /## Columns/);
  assert.match(analysis.reportMarkdown, /Recommended chart/);

  const registry = new ToolRegistry().registerMany(createBuiltinTools({ sandbox: null }));
  const builtin = await registry.call('data.analyze', { path: 'sales.csv' }, { trustedRoot });
  assert.equal(builtin.kind, 'data-analysis');
  assert.equal(builtin.chart.title, 'revenue by region');
});
