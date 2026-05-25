import fs from 'node:fs';
import path from 'node:path';

function rate(value) {
  return Number.isFinite(value) ? value : 0;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function baselinePassRate(baseline) {
  if (!baseline) return null;
  const value = baseline.passRate ?? baseline.summary?.passRate;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function compareBaseline(summary, baseline, regressionTolerance) {
  const passRate = rate(summary.passRate);
  const baselineRate = baselinePassRate(baseline);
  if (baselineRate === null) {
    return {
      available: false,
      passRate: null,
      delta: null,
      regressionTolerance,
      regressed: false,
    };
  }
  const delta = passRate - baselineRate;
  return {
    available: true,
    passRate: baselineRate,
    delta,
    regressionTolerance,
    regressed: delta < -regressionTolerance,
  };
}

function renderHtml(report) {
  const rows = report.results.map((result) => {
    const passed = result.score?.passed ? 'pass' : 'fail';
    const score = Number(result.score?.score ?? 0).toFixed(3);
    return `<tr><td>${escapeHtml(result.taskId)}</td><td>${passed}</td><td>${score}</td></tr>`;
  }).join('\n');
  const passRate = (report.summary.passRate * 100).toFixed(1);
  const baseline = report.baseline.available
    ? `${(report.baseline.passRate * 100).toFixed(1)}% (${report.baseline.delta >= 0 ? '+' : ''}${(report.baseline.delta * 100).toFixed(1)}%)`
    : 'none';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Eval Report</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 32px; color: #111; }
    table { border-collapse: collapse; width: 100%; margin-top: 16px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background: #f4f4f4; }
  </style>
</head>
<body>
  <h1>Eval Report</h1>
  <p>Generated: ${escapeHtml(report.generatedAt)}</p>
  <p>Pass rate: ${passRate}% (${report.summary.passedTasks}/${report.summary.totalTasks})</p>
  <p>Baseline: ${escapeHtml(baseline)}</p>
  <table>
    <thead><tr><th>Task</th><th>Status</th><th>Score</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

export function generateEvalReport(summary, {
  baseline = null,
  regressionTolerance = 0.05,
  generatedAt = new Date().toISOString(),
} = {}) {
  const json = {
    generatedAt,
    summary: {
      totalTasks: summary.totalTasks,
      passedTasks: summary.passedTasks,
      failedTasks: summary.failedTasks,
      passRate: rate(summary.passRate),
    },
    baseline: compareBaseline(summary, baseline, regressionTolerance),
    results: summary.results || [],
  };
  return {
    json,
    html: renderHtml(json),
  };
}

export function writeEvalReport(summary, {
  outDir,
  baseline = null,
  regressionTolerance = 0.05,
  generatedAt,
} = {}) {
  if (!outDir) throw new Error('writeEvalReport requires outDir');
  fs.mkdirSync(outDir, { recursive: true });
  const report = generateEvalReport(summary, { baseline, regressionTolerance, generatedAt });
  const jsonPath = path.join(outDir, 'latest.json');
  const htmlPath = path.join(outDir, 'latest.html');
  fs.writeFileSync(jsonPath, `${JSON.stringify(report.json, null, 2)}\n`, 'utf8');
  fs.writeFileSync(htmlPath, report.html, 'utf8');
  return { ...report, jsonPath, htmlPath };
}
