import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createAgentTools } from '../src/kimi/agent-tools.js';
import { createBuiltinTools } from '../src/tools/builtin-tools.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { analyzeDataFile } from '../src/tools/data/report.js';
import { profileDataFile } from '../src/tools/data/profile.js';
import { createXlsxWorkbook } from '../src/artifacts/xlsx-writer.js';
import { readArtifactManifest } from '../src/artifacts/live-artifact.js';
import { makeTestWorkspace } from './test-fixtures.js';
import type { AgentTool } from '../src/kimi/agent-tools.js';
import type { DataChartArtifact } from '../src/tools/data/artifact.js';
import type { DataAnalysis } from '../src/tools/data/report.js';
import type { DataColumnProfile, DataNumericSummary, DataProfile, DataTopValue } from '../src/tools/data/profile.js';

type CallableAgentTool = AgentTool & { handler: NonNullable<AgentTool['handler']> };

function workspace(): string {
  return makeTestWorkspace('kcw-data-profile');
}

function requireColumn(profile: DataProfile, name: string): DataColumnProfile {
  const column = profile.columns.find((candidate) => candidate.name === name);
  assert.ok(column, `column ${name} should be present`);
  return column;
}

function requireNumeric(column: DataColumnProfile): DataNumericSummary {
  assert.ok(column.numeric, `column ${column.name} should have numeric stats`);
  return column.numeric;
}

function requireTopValue(column: DataColumnProfile, index = 0): DataTopValue {
  const value = column.topValues[index];
  assert.ok(value, `column ${column.name} should have top value ${index}`);
  return value;
}

function requireDataProfile(value: unknown): DataProfile {
  assert.ok(value && typeof value === 'object' && (value as DataProfile).kind === 'data-profile');
  return value as DataProfile;
}

function requireDataAnalysis(value: unknown): DataAnalysis {
  assert.ok(value && typeof value === 'object' && (value as DataAnalysis).kind === 'data-analysis');
  return value as DataAnalysis;
}

function requireDataChartArtifact(value: unknown): DataChartArtifact {
  assert.ok(value && typeof value === 'object' && (value as DataChartArtifact).kind === 'data-chart-artifact');
  return value as DataChartArtifact;
}

function requireChart(analysis: DataAnalysis): NonNullable<DataAnalysis['chart']> {
  assert.ok(analysis.chart, 'analysis should include a chart');
  return analysis.chart;
}

function requireAgentTool(tool: AgentTool | undefined, name: string): CallableAgentTool {
  assert.ok(tool?.handler, `agent tool ${name} should be present`);
  return tool as CallableAgentTool;
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
  assert.equal(requireColumn(profile, 'date').type, 'date');
  const region = requireColumn(profile, 'region');
  assert.equal(region.type, 'text');
  assert.deepEqual(requireTopValue(region), { value: 'North', count: 2 });
  const revenue = requireColumn(profile, 'revenue');
  const revenueNumeric = requireNumeric(revenue);
  assert.equal(revenue.type, 'number');
  assert.equal(revenueNumeric.min, 10.5);
  assert.equal(revenueNumeric.max, 31);
  assert.equal(revenueNumeric.mean, 20.5);
  assert.equal(requireColumn(profile, 'units').empty, 1);
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
  const builtin = requireDataProfile(await registry.call('data.profile', { path: 'data.csv' }, { trustedRoot }));
  assert.equal(requireColumn(builtin, 'value').type, 'number');

  const agentTool = requireAgentTool(
    createAgentTools({ trustedRoot }).find((tool) => tool.name === 'AnalyzeDataFile'),
    'AnalyzeDataFile',
  );
  assert.equal(agentTool?.mutating, false);
  assert.equal(agentTool?.risk, 'safe');
  const agentResult = requireDataAnalysis(await agentTool.handler({ path: 'data.csv' }));
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
  const chart = requireChart(analysis);

  assert.equal(analysis.kind, 'data-analysis');
  assert.equal(analysis.rowCount, 3);
  assert.equal(analysis.columnCount, 2);
  assert.equal(chart.kind, 'bar');
  assert.deepEqual(chart.data.labels, ['North', 'South']);
  assert.deepEqual(chart.data.values, [15, 15]);
  assert.match(analysis.reportMarkdown, /## Columns/);
  assert.match(analysis.reportMarkdown, /Recommended chart/);

  const registry = new ToolRegistry().registerMany(createBuiltinTools({ sandbox: null }));
  const builtin = requireDataAnalysis(await registry.call('data.analyze', { path: 'sales.csv' }, { trustedRoot }));
  assert.equal(builtin.kind, 'data-analysis');
  assert.equal(requireChart(builtin).title, 'revenue by region');
});

test('data analysis reads the first worksheet from xlsx files', () => {
  const trustedRoot = workspace();
  fs.writeFileSync(
    path.join(trustedRoot, 'sales.xlsx'),
    createXlsxWorkbook({
      sheetName: 'Sales',
      columns: ['region', 'revenue'],
      rows: [
        ['North', 10],
        ['South', 15],
        ['North', 5],
      ],
    }),
  );

  const profile = profileDataFile({ trustedRoot, path: 'sales.xlsx' });
  assert.equal(profile.delimiter, 'xlsx');
  assert.equal(profile.rowCount, 3);
  assert.equal(requireColumn(profile, 'revenue').type, 'number');

  const analysis = analyzeDataFile({ trustedRoot, path: 'sales.xlsx' });
  const chart = requireChart(analysis);
  assert.equal(analysis.kind, 'data-analysis');
  assert.equal(chart.kind, 'bar');
  assert.deepEqual(chart.data.labels, ['North', 'South']);
  assert.deepEqual(chart.data.values, [15, 15]);
  assert.match(analysis.reportMarkdown, /Data analysis: sales\.xlsx/);
});

test('data analysis can persist a chart artifact through approval-gated tools', async () => {
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

  const registry = new ToolRegistry().registerMany(createBuiltinTools({ sandbox: null }));
  const descriptor = registry.descriptor('data.createChartArtifact');
  assert.equal(descriptor?.mutating, true);
  assert.equal(descriptor?.risk, 'high');
  assert.equal(descriptor?.requiresApproval, true);

  const result = requireDataChartArtifact(await registry.call(
    'data.createChartArtifact',
    { path: 'sales.csv', id: 'sales_chart', title: 'Sales by region' },
    { trustedRoot },
  ));
  assert.equal(result.kind, 'data-chart-artifact');
  assert.equal(result.chart.kind, 'bar');
  assert.deepEqual(result.chart.data.labels, ['North', 'South']);
  assert.equal(result.artifact.relativePath, '.AgentCowork/artifacts/sales_chart.html');
  assert.equal(result.artifact.viewUrl, '/api/artifacts/live/sales_chart');
  assert.equal(fs.existsSync(path.join(trustedRoot, '.AgentCowork', 'artifacts', 'sales_chart.html')), true);

  const manifest = readArtifactManifest({ trustedRoot, id: 'sales_chart' });
  assert.equal(manifest.title, 'Sales by region');
  assert.equal(manifest.viz.kind, 'bar');

  const agentTool = requireAgentTool(
    createAgentTools({ trustedRoot }).find((tool) => tool.name === 'CreateDataChartArtifact'),
    'CreateDataChartArtifact',
  );
  assert.equal(agentTool?.mutating, true);
  assert.equal(agentTool?.risk, 'high');
  assert.equal(agentTool?.requiresApproval, true);
  const agentResult = requireDataChartArtifact(await agentTool.handler({ path: 'sales.csv', id: 'agent_sales_chart' }));
  assert.equal(agentResult.artifact.relativePath, '.AgentCowork/artifacts/agent_sales_chart.html');
});
