import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');
const reportPath = path.join(buildDir, 'mvp-acceptance-audit.json');
const strict = process.argv.includes('--strict');

function readJson(filePath) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function fileEvidence(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      path: filePath,
      exists: true,
      bytes: stat.size,
      lastWriteTime: stat.mtime.toISOString(),
    };
  } catch {
    return { path: filePath, exists: false, bytes: 0, lastWriteTime: null };
  }
}

function readPngSize(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') {
      return null;
    }
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getHealth(url) {
  return await new Promise((resolve) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve({ statusCode: response.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ statusCode: response.statusCode, body });
        }
      });
    });
    request.on('error', (error) => resolve({ error: error.message }));
    request.setTimeout(1500, () => request.destroy(new Error('health request timed out')));
  });
}

function requirement(id, label, status, evidence) {
  return { id, label, status, evidence };
}

function passed(requirements, ids) {
  return ids.every((id) => requirements.find((item) => item.id === id)?.status === 'passed');
}

async function main() {
  fs.mkdirSync(buildDir, { recursive: true });

  const runtimeFile = path.join(buildDir, 'mvp-runtime.json');
  const verificationFile = path.join(buildDir, 'mvp-verification-report.json');
  const renderedFile = path.join(buildDir, 'rendered-ui-smoke-report.json');
  const liveMvpSmokeFile = path.join(buildDir, 'live-mvp-smoke-report.json');
  const runtimeSmokeFile = path.join(buildDir, 'mvp-runtime-smoke-report.json');
  const windowsResourceSmokeFile = path.join(buildDir, 'windows-client-resource-smoke-report.json');
  const readinessFile = path.join(buildDir, 'windows-client-readiness.json');
  const windowsVerificationFile = path.join(buildDir, 'mvp-verification-report-windows.json');

  const runtime = readJson(runtimeFile);
  const healthUrl = runtime.ok ? `http://${runtime.value.host}:${runtime.value.port}/health` : null;
  const health = healthUrl ? await getHealth(healthUrl) : null;
  const pidAlive = runtime.ok && isPidAlive(runtime.value.pid);
  const healthOk = health?.statusCode === 200 && health?.body?.ok === true && health?.body?.service === 'kimi-cowork-host';

  const verification = readJson(verificationFile);
  const rendered = readJson(renderedFile);
  const liveMvpSmoke = readJson(liveMvpSmokeFile);
  const runtimeSmoke = readJson(runtimeSmokeFile);
  const windowsResourceSmoke = readJson(windowsResourceSmokeFile);
  const readiness = readJson(readinessFile);
  const windowsVerification = readJson(windowsVerificationFile);

  const screenshotPath = rendered.ok ? rendered.value.screenshotPath : path.join(buildDir, 'rendered-ui-smoke-1536x900.png');
  const screenshot = fileEvidence(screenshotPath);
  const screenshotSize = readPngSize(screenshotPath);
  const artifactEvidence =
    rendered.ok && Array.isArray(rendered.value.artifacts)
      ? rendered.value.artifacts.map((artifactPath) => fileEvidence(artifactPath))
      : [];
  const auditEvidence = rendered.ok ? fileEvidence(rendered.value.auditPath) : null;

  const desktopLayout = rendered.value?.desktopLayout;
  const compactLayout = rendered.value?.compactLayout;
  const interaction = rendered.value?.interaction;
  const liveMvpScreenshotPath = liveMvpSmoke.ok
    ? liveMvpSmoke.value.screenshotPath
    : path.join(buildDir, 'live-mvp-smoke-1536x900.png');
  const liveMvpScreenshot = fileEvidence(liveMvpScreenshotPath);
  const liveMvpScreenshotSize = readPngSize(liveMvpScreenshotPath);
  const liveMvpDesktopLayout = liveMvpSmoke.value?.desktopLayout;
  const liveMvpInteraction = liveMvpSmoke.value?.interaction;
  const liveMvpArtifactEvidence =
    liveMvpSmoke.ok && Array.isArray(liveMvpSmoke.value.artifacts)
      ? liveMvpSmoke.value.artifacts.map((artifactPath) => fileEvidence(artifactPath))
      : [];
  const liveMvpAuditEvidence = liveMvpSmoke.ok ? fileEvidence(liveMvpSmoke.value.auditPath) : null;
  const windowsResourceScreenshotPath = windowsResourceSmoke.ok
    ? windowsResourceSmoke.value.screenshotPath
    : path.join(buildDir, 'windows-client-resource-smoke-1536x900.png');
  const windowsResourceScreenshot = fileEvidence(windowsResourceScreenshotPath);
  const windowsResourceScreenshotSize = readPngSize(windowsResourceScreenshotPath);
  const windowsResourceDesktopLayout = windowsResourceSmoke.value?.desktopLayout;
  const windowsResourceCompactLayout = windowsResourceSmoke.value?.compactLayout;
  const windowsResourceInteraction = windowsResourceSmoke.value?.interaction;

  const visualPassed =
    rendered.value?.ok === true &&
    screenshot.exists &&
    screenshotSize?.width === 1536 &&
    screenshotSize?.height === 900 &&
    desktopLayout?.title === 'Kimi Cowork' &&
    desktopLayout?.hasKimi === true &&
    desktopLayout?.hasCowork === true &&
    desktopLayout?.hasLocalFolder === true &&
    desktopLayout?.hasApprove === true &&
    desktopLayout?.hasFrameworkOverlay === false &&
    desktopLayout?.scroll?.width <= desktopLayout?.scroll?.clientWidth + 1 &&
    compactLayout?.issues?.length === 0 &&
    compactLayout?.scroll?.width <= compactLayout?.scroll?.clientWidth + 1 &&
    compactLayout?.scroll?.height <= compactLayout?.scroll?.clientHeight + 1;

  const operationPassed =
    rendered.value?.ok === true &&
    interaction?.afterPlan?.status === 'Plan Ready' &&
    interaction?.afterPlan?.opCount >= 1 &&
    interaction?.afterApprove?.status === 'Applied Locally' &&
    interaction?.afterApprove?.doneClass === true &&
    artifactEvidence.length > 0 &&
    artifactEvidence.every((artifact) => artifact.exists && artifact.bytes > 0) &&
    auditEvidence?.exists === true &&
    auditEvidence.bytes > 0;

  const nativeCheck = windowsVerification.value?.checks?.find((check) => check.name === 'native Windows client operation smoke');
  const nativePassed = nativeCheck?.status === 'passed';
  const nativeBlocked =
    readiness.value?.blockedByAsr === true ||
    nativeCheck?.status === 'blocked' ||
    nativeCheck?.blockedByAsr === true;

  const requirements = [
    requirement('running-web-mvp', 'Runnable local MVP service with runtime file and health check', pidAlive && healthOk ? 'passed' : 'failed', {
      runtimeFile,
      runtime: runtime.ok ? runtime.value : null,
      runtimeError: runtime.ok ? null : runtime.error,
      pidAlive,
      healthUrl,
      health,
    }),
    requirement('default-verifier', 'Default MVP verifier covers syntax, unit tests, host operations, runtime, UI contract, and rendered browser smoke', verification.value?.ok === true && verification.value?.summary?.failed === 0 ? 'passed' : 'failed', {
      reportPath: verificationFile,
      generatedAt: verification.value?.generatedAt,
      summary: verification.value?.summary,
      notes: verification.value?.notes,
    }),
    requirement('visual-fidelity', 'Rendered UI matches Kimi-style shell and fits 1536x900 plus 1366x768 without overflow', visualPassed ? 'passed' : 'failed', {
      reportPath: renderedFile,
      generatedAt: rendered.value?.generatedAt,
      screenshot,
      screenshotSize,
      desktopLayout,
      compactLayout,
    }),
    requirement('local-operation-test', 'Browser operation flow reads trusted files, previews work, approves locally, writes artifact, and writes audit', operationPassed ? 'passed' : 'failed', {
      reportPath: renderedFile,
      interaction,
      artifacts: artifactEvidence,
      audit: auditEvidence,
    }),
    requirement(
      'live-running-operation-test',
      'Currently running MVP service can be operated through the browser and writes into its runtime workspace',
      liveMvpSmoke.value?.ok === true &&
        liveMvpScreenshot.exists &&
        liveMvpScreenshotSize?.width === 1536 &&
        liveMvpScreenshotSize?.height === 900 &&
        liveMvpSmoke.value?.runtime?.pid === runtime.value?.pid &&
        liveMvpSmoke.value?.runtime?.url === runtime.value?.url &&
        liveMvpDesktopLayout?.title === 'Kimi Cowork' &&
        liveMvpDesktopLayout?.workspace === runtime.value?.workspace &&
        liveMvpInteraction?.afterPlan?.status === 'Plan Ready' &&
        liveMvpInteraction?.afterPlan?.opCount >= 1 &&
        liveMvpInteraction?.afterApprove?.status === 'Applied Locally' &&
        liveMvpInteraction?.afterApprove?.doneClass === true &&
        liveMvpArtifactEvidence.length > 0 &&
        liveMvpArtifactEvidence.every((artifact) => artifact.exists && artifact.bytes > 0) &&
        liveMvpAuditEvidence?.exists === true &&
        liveMvpSmoke.value?.auditSizeAfter > liveMvpSmoke.value?.auditSizeBefore
        ? 'passed'
        : 'failed',
      {
        reportPath: liveMvpSmokeFile,
        generatedAt: liveMvpSmoke.value?.generatedAt,
        runtime: liveMvpSmoke.value?.runtime,
        screenshot: liveMvpScreenshot,
        screenshotSize: liveMvpScreenshotSize,
        desktopLayout: liveMvpDesktopLayout,
        interaction: liveMvpInteraction,
        artifacts: liveMvpArtifactEvidence,
        audit: liveMvpAuditEvidence,
        auditSizeBefore: liveMvpSmoke.value?.auditSizeBefore,
        auditSizeAfter: liveMvpSmoke.value?.auditSizeAfter,
      },
    ),
    requirement('runtime-lifecycle-test', 'MVP lifecycle smoke proves start, status, stop, and runtime cleanup', runtimeSmoke.value?.ok === true ? 'passed' : 'failed', {
      reportPath: runtimeSmokeFile,
      generatedAt: runtimeSmoke.value?.generatedAt,
      port: runtimeSmoke.value?.port,
      stopped: runtimeSmoke.value?.stop?.stopped,
    }),
    requirement(
      'native-windows-resource-smoke',
      'Native Windows client resources render in static file mode and support preview/approve UI transitions',
      windowsResourceSmoke.value?.ok === true &&
        windowsResourceScreenshot.exists &&
        windowsResourceScreenshotSize?.width === 1536 &&
        windowsResourceScreenshotSize?.height === 900 &&
        windowsResourceDesktopLayout?.title === 'Kimi Cowork' &&
        windowsResourceDesktopLayout?.protocol === 'file:' &&
        windowsResourceDesktopLayout?.hostApi === false &&
        windowsResourceDesktopLayout?.hasKimi === true &&
        windowsResourceDesktopLayout?.hasCowork === true &&
        windowsResourceDesktopLayout?.hasLocalFolder === true &&
        windowsResourceDesktopLayout?.hasApprove === true &&
        windowsResourceCompactLayout?.issues?.length === 0 &&
        windowsResourceInteraction?.afterPlan?.status === 'Preview Mode' &&
        windowsResourceInteraction?.afterApprove?.status === 'Preview Applied' &&
        windowsResourceInteraction?.afterApprove?.doneClass === true
        ? 'passed'
        : 'failed',
      {
        reportPath: windowsResourceSmokeFile,
        generatedAt: windowsResourceSmoke.value?.generatedAt,
        resourcesDir: windowsResourceSmoke.value?.resourcesDir,
        screenshot: windowsResourceScreenshot,
        screenshotSize: windowsResourceScreenshotSize,
        desktopLayout: windowsResourceDesktopLayout,
        compactLayout: windowsResourceCompactLayout,
        interaction: windowsResourceInteraction,
      },
    ),
    requirement('native-windows-window-smoke', 'Native Windows C client window-level smoke', nativePassed ? 'passed' : nativeBlocked ? 'blocked' : 'failed', {
      readinessReportPath: readinessFile,
      windowsVerificationReportPath: windowsVerification.ok ? windowsVerificationFile : null,
      executable: readiness.value?.executable,
      executableExists: readiness.value?.executableExists,
      readyToRunNativeSmoke: readiness.value?.readyToRunNativeSmoke,
      blockedByAsr: readiness.value?.blockedByAsr,
      defender: readiness.value?.defender,
      latestMatchingAsrEvent: readiness.value?.latestMatchingAsrEvent
        ? {
            timeCreated: readiness.value.latestMatchingAsrEvent.timeCreated,
            id: readiness.value.latestMatchingAsrEvent.id,
            providerName: readiness.value.latestMatchingAsrEvent.providerName,
          }
        : null,
      requiredUserAction: readiness.value?.requiredUserAction,
      nativeCheck: nativeCheck || null,
    }),
  ];

  const webRequirementIds = [
    'running-web-mvp',
    'default-verifier',
    'visual-fidelity',
    'local-operation-test',
    'live-running-operation-test',
    'runtime-lifecycle-test',
    'native-windows-resource-smoke',
  ];
  const webHostMvpReady = passed(requirements, webRequirementIds);
  const nativeWindowsReady = requirements.find((item) => item.id === 'native-windows-window-smoke')?.status === 'passed';
  const blocked = requirements.filter((item) => item.status === 'blocked');
  const failed = requirements.filter((item) => item.status === 'failed');

  const report = {
    ok: webHostMvpReady && failed.length === 0,
    completeGoal: webHostMvpReady && nativeWindowsReady,
    generatedAt: new Date().toISOString(),
    repoRoot,
    reportPath,
    summary: {
      passed: requirements.filter((item) => item.status === 'passed').length,
      failed: failed.length,
      blocked: blocked.length,
      webHostMvpReady,
      nativeWindowsReady,
    },
    requirements,
  };

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));

  if (strict && !report.completeGoal) {
    process.exit(1);
  }
  if (!webHostMvpReady || failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
