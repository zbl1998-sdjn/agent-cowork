// MVP 验收证据汇总门禁(scripts · 门禁(gate))
// ---------------------------------------------------------------------------
// 职责:不自己跑测试,而是聚合 build/ 下各路冒烟与验证报告(mvp-runtime、
//       default-verifier、rendered-ui-smoke、live-mvp-smoke、runtime-smoke、
//       windows-resource-smoke、windows-client-readiness、windows-verification),
//       逐条评定验收需求 passed/failed/blocked(运行中实例健康、视觉保真、
//       本地操作闭环、原生 Windows 资源/窗口冒烟等),并核证截图尺寸/产物字节/
//       审计增长;strict 模式额外要求所有证据 <10min 且来自当前 repo。
//       汇总写 build/mvp-acceptance-audit.json 并打印。
// 用法:npm run audit:mvp(经 run-host-node.mjs 跑本 .ts);加 --strict 进严格门禁。
//       非严格:webHostMvpReady 未达成或有 failed 即 exit 1 阻断;
//       严格:再要求 completeGoal 且证据新鲜,否则 exit 1 阻断。
// 依赖:build/ 下由各 smoke/verify 脚本预先产出的报告 JSON;运行中实例 /health。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');
const reportPath = path.join(buildDir, 'mvp-acceptance-audit.json');
const strict = process.argv.includes('--strict');

type JsonRecord = Record<string, unknown>;
type ReadJsonResult<T extends JsonRecord> =
  | { ok: true; value: T; error?: undefined }
  | { ok: false; value?: undefined; error: string };
type FileEvidence = { path: string; exists: boolean; bytes: number; lastWriteTime: string | null };
type PngSize = { width: number; height: number };
type HealthResult = { statusCode?: number; body?: JsonRecord | string; error?: string };
type RequirementStatus = 'passed' | 'failed' | 'blocked';
type Requirement = { id: string; label: string; status: RequirementStatus; evidence: unknown };
type LayoutScroll = { width?: number; clientWidth?: number; height?: number; clientHeight?: number };
type SmokeLayout = {
  activeMode?: unknown;
  hasGreeting?: unknown;
  hasCowork?: unknown;
  hasModeTabs?: unknown;
  hasSidebarActions?: unknown;
  hasQuickActions?: unknown;
  hasKimi?: unknown;
  hasLocalFolder?: unknown;
  hasApprove?: unknown;
  title?: unknown;
  hasShell?: unknown;
  hasTimeline?: unknown;
  hasComposer?: unknown;
  hasConversationRail?: unknown;
  hasHeaderActions?: unknown;
  hasFrameworkOverlay?: unknown;
  workspace?: unknown;
  protocol?: unknown;
  hostApi?: unknown;
  scroll?: LayoutScroll;
  issues?: unknown[];
};
type SmokeInteraction = {
  afterPlan?: { status?: unknown; opCount?: number; preview?: string; approveText?: unknown };
  afterApprove?: { status?: unknown; doneClass?: unknown; approval?: string; artifactCards?: number };
};
type ReportMetadata = { generatedAt?: string; repoRoot?: string };
type RuntimeReport = ReportMetadata & {
  host?: unknown;
  port?: unknown;
  pid?: unknown;
  url?: unknown;
  workspace?: unknown;
};
type VerificationReport = ReportMetadata & {
  ok?: unknown;
  summary?: { failed?: unknown };
  notes?: unknown;
  checks?: NativeCheck[];
};
type RenderedSmokeReport = ReportMetadata & {
  ok?: unknown;
  screenshotPath?: string;
  artifacts?: unknown;
  auditPath?: string;
  desktopLayout?: SmokeLayout;
  compactLayout?: SmokeLayout;
  interaction?: SmokeInteraction;
};
type LiveMvpSmokeReport = RenderedSmokeReport & {
  runtime?: RuntimeReport;
  auditSizeBefore?: unknown;
  auditSizeAfter?: unknown;
};
type WindowsResourceSmokeReport = RenderedSmokeReport & {
  resourcesDir?: unknown;
};
type ReadinessReport = ReportMetadata & {
  executable?: unknown;
  executableExists?: unknown;
  readyToRunNativeSmoke?: unknown;
  blockedByAsr?: unknown;
  exactExclusionRequired?: unknown;
  diagnosis?: unknown;
  defender?: unknown;
  latestMatchingAsrEvent?: { timeCreated?: unknown; id?: unknown; providerName?: unknown };
  explicitApprovalText?: unknown;
  proposedUnblockCommand?: unknown;
  rerunCommand?: unknown;
  fullVerificationCommand?: unknown;
  strictAuditCommand?: unknown;
  requiredUserAction?: unknown;
};
type NativeCheck = { name?: unknown; status?: unknown; blockedByAsr?: unknown };
type EvidenceIssue = { label: string; reason: 'stale'; generatedAt: string } | { label: string; reason: 'wrong-repo'; repoRoot: string };

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function atLeast(value: unknown, minimum: number): boolean {
  return typeof value === 'number' && value >= minimum;
}

function greaterThan(left: unknown, right: unknown): boolean {
  return typeof left === 'number' && typeof right === 'number' && left > right;
}

function fitsWidth(layout: SmokeLayout | undefined): boolean {
  const scroll = layout?.scroll;
  return typeof scroll?.width === 'number' && typeof scroll.clientWidth === 'number' && scroll.width <= scroll.clientWidth + 1;
}

function fitsHeight(layout: SmokeLayout | undefined): boolean {
  const scroll = layout?.scroll;
  return typeof scroll?.height === 'number' && typeof scroll.clientHeight === 'number' && scroll.height <= scroll.clientHeight + 1;
}

function readJson<T extends JsonRecord>(filePath: string): ReadJsonResult<T> {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!isRecord(value)) {
      return { ok: false, error: 'JSON root is not an object' };
    }
    return { ok: true, value: value as T };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function fileEvidence(filePath: string): FileEvidence {
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

function readPngSize(filePath: string): PngSize | null {
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

function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getHealth(url: string): Promise<HealthResult> {
  return await new Promise((resolve) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
            body += String(chunk);
          });
          response.on('end', () => {
            const statusCode = response.statusCode ?? 0;
            try {
              const parsedBody = JSON.parse(body) as unknown;
              resolve({ statusCode, body: isRecord(parsedBody) ? parsedBody : body });
            } catch {
              resolve({ statusCode, body });
            }
          });
    });
    request.on('error', (error) => resolve({ error: errorMessage(error) }));
    request.setTimeout(1500, () => request.destroy(new Error('health request timed out')));
  });
}

function requirement(id: string, label: string, status: RequirementStatus, evidence: unknown): Requirement {
  return { id, label, status, evidence };
}

function passed(requirements: Requirement[], ids: string[]): boolean {
  return ids.every((id) => requirements.find((item) => item.id === id)?.status === 'passed');
}

function hasReferenceFunctionalShell(layout: SmokeLayout | undefined): boolean {
  if (!layout) {
    return false;
  }

  const newShell =
    layout.activeMode === '对话' &&
    layout.hasGreeting === true &&
    layout.hasCowork === true &&
    layout.hasModeTabs === true &&
    layout.hasSidebarActions === true &&
    layout.hasQuickActions === true;

  const legacyShell =
    layout.hasKimi === true &&
    layout.hasCowork === true &&
    layout.hasLocalFolder === true &&
    layout.hasApprove === true;

  return newShell || legacyShell;
}

function hasReactLiveShell(layout: SmokeLayout | undefined): boolean {
  if (!layout) {
    return false;
  }
  return (
    layout.title === 'Agent Cowork' &&
    layout.hasShell === true &&
    layout.hasTimeline === true &&
    layout.hasComposer === true &&
    layout.hasConversationRail === true &&
    layout.hasHeaderActions === true &&
    layout.hasQuickActions === true &&
    fitsWidth(layout)
  );
}

function liveInteractionPassed(interaction: SmokeInteraction | undefined): boolean {
  if (!interaction) {
    return false;
  }

  const legacyPassed =
    interaction.afterPlan?.status === '计划就绪' &&
    atLeast(interaction.afterPlan?.opCount, 1) &&
    interaction.afterApprove?.status === '已在本机执行' &&
    interaction.afterApprove?.doneClass === true;

  const reactPassed =
    interaction.afterPlan?.preview?.includes('操作预览') === true &&
    atLeast(interaction.afterPlan?.opCount, 1) &&
    interaction.afterPlan?.approveText === '审批执行' &&
    interaction.afterApprove?.approval?.includes('已审批') === true &&
    atLeast(interaction.afterApprove?.artifactCards, 1);

  return legacyPassed || reactPassed;
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

  const runtime = readJson<RuntimeReport>(runtimeFile);
  const healthUrl = runtime.ok ? `http://${runtime.value.host}:${runtime.value.port}/health` : null;
  const health = healthUrl ? await getHealth(healthUrl) : null;
  const pidAlive = runtime.ok && isPidAlive(runtime.value.pid);
  const healthBody = isRecord(health?.body) ? health.body : null;
  const healthOk = health?.statusCode === 200 && healthBody?.ok === true && healthBody?.service === 'agent-cowork-host';

  const verification = readJson<VerificationReport>(verificationFile);
  const rendered = readJson<RenderedSmokeReport>(renderedFile);
  const liveMvpSmoke = readJson<LiveMvpSmokeReport>(liveMvpSmokeFile);
  const runtimeSmoke = readJson<JsonRecord & { ok?: unknown; generatedAt?: string; port?: unknown; stop?: { stopped?: unknown } }>(runtimeSmokeFile);
  const windowsResourceSmoke = readJson<WindowsResourceSmokeReport>(windowsResourceSmokeFile);
  const readiness = readJson<ReadinessReport>(readinessFile);
  const windowsVerification = readJson<VerificationReport>(windowsVerificationFile);

  const screenshotPath =
    rendered.ok && rendered.value.screenshotPath
      ? rendered.value.screenshotPath
      : path.join(buildDir, 'rendered-ui-smoke-1536x900.png');
  const screenshot = fileEvidence(screenshotPath);
  const screenshotSize = readPngSize(screenshotPath);
  const artifactEvidence =
    rendered.ok && Array.isArray(rendered.value.artifacts)
      ? rendered.value.artifacts.filter((artifactPath): artifactPath is string => typeof artifactPath === 'string').map((artifactPath) => fileEvidence(artifactPath))
      : [];
  const auditEvidence = rendered.ok && rendered.value.auditPath ? fileEvidence(rendered.value.auditPath) : null;

  const desktopLayout = rendered.value?.desktopLayout;
  const compactLayout = rendered.value?.compactLayout;
  const interaction = rendered.value?.interaction;
  const liveMvpScreenshotPath =
    liveMvpSmoke.ok && liveMvpSmoke.value.screenshotPath
      ? liveMvpSmoke.value.screenshotPath
      : path.join(buildDir, 'live-mvp-smoke-1536x900.png');
  const liveMvpScreenshot = fileEvidence(liveMvpScreenshotPath);
  const liveMvpScreenshotSize = readPngSize(liveMvpScreenshotPath);
  const liveMvpDesktopLayout = liveMvpSmoke.value?.desktopLayout;
  const liveMvpInteraction = liveMvpSmoke.value?.interaction;
  const liveMvpArtifactEvidence =
    liveMvpSmoke.ok && Array.isArray(liveMvpSmoke.value.artifacts)
      ? liveMvpSmoke.value.artifacts.filter((artifactPath): artifactPath is string => typeof artifactPath === 'string').map((artifactPath) => fileEvidence(artifactPath))
      : [];
  const liveMvpAuditEvidence = liveMvpSmoke.ok && liveMvpSmoke.value.auditPath ? fileEvidence(liveMvpSmoke.value.auditPath) : null;
  const windowsResourceScreenshotPath =
    windowsResourceSmoke.ok && windowsResourceSmoke.value.screenshotPath
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
    desktopLayout?.title === 'Agent Cowork' &&
    hasReferenceFunctionalShell(desktopLayout) &&
    desktopLayout?.hasFrameworkOverlay === false &&
    fitsWidth(desktopLayout) &&
    compactLayout?.issues?.length === 0 &&
    fitsWidth(compactLayout) &&
    fitsHeight(compactLayout);

  const operationPassed =
    rendered.value?.ok === true &&
    interaction?.afterPlan?.status === '计划就绪' &&
    atLeast(interaction?.afterPlan?.opCount, 1) &&
    interaction?.afterApprove?.status === '已在本机执行' &&
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

  // Evidence integrity (strict mode): a release gate must never "pass" on stale
  // or foreign-repo evidence. Reject any contributing report that is older than
  // STALE_MS or whose recorded repoRoot points at a different checkout (e.g. an
  // old `agent cowork` tree). Reports without these fields are not penalised.
  const STALE_MS = 10 * 60 * 1000;
  const evidenceReports = [
    { label: 'mvp-runtime', value: runtime.value },
    { label: 'default-verifier', value: verification.value },
    { label: 'rendered-ui-smoke', value: rendered.value },
    { label: 'live-mvp-smoke', value: liveMvpSmoke.value },
    { label: 'runtime-smoke', value: runtimeSmoke.value },
    { label: 'windows-resource-smoke', value: windowsResourceSmoke.value },
    { label: 'windows-client-readiness', value: readiness.value },
    { label: 'windows-verification', value: windowsVerification.value },
  ];
  const evidenceIssues: EvidenceIssue[] = [];
  for (const { label, value } of evidenceReports) {
    if (!value || typeof value !== 'object') continue;
    if (typeof value.generatedAt === 'string') {
      const ts = Date.parse(value.generatedAt);
      if (Number.isFinite(ts) && Date.now() - ts > STALE_MS) {
        evidenceIssues.push({ label, reason: 'stale', generatedAt: value.generatedAt });
      }
    }
    if (typeof value.repoRoot === 'string' && path.resolve(value.repoRoot) !== path.resolve(repoRoot)) {
      evidenceIssues.push({ label, reason: 'wrong-repo', repoRoot: value.repoRoot });
    }
  }
  const evidenceFresh = evidenceIssues.length === 0;

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
    requirement('visual-fidelity', 'Rendered UI matches the reference 对话/协作/代码 shell and fits 1536x900 plus 1366x768 without overflow', visualPassed ? 'passed' : 'failed', {
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
        liveMvpDesktopLayout?.title === 'Agent Cowork' &&
        liveMvpDesktopLayout?.workspace === runtime.value?.workspace &&
        (hasReferenceFunctionalShell(liveMvpDesktopLayout) || hasReactLiveShell(liveMvpDesktopLayout)) &&
        liveInteractionPassed(liveMvpInteraction) &&
        liveMvpArtifactEvidence.length > 0 &&
        liveMvpArtifactEvidence.every((artifact) => artifact.exists && artifact.bytes > 0) &&
        liveMvpAuditEvidence?.exists === true &&
        greaterThan(liveMvpSmoke.value?.auditSizeAfter, liveMvpSmoke.value?.auditSizeBefore)
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
        windowsResourceDesktopLayout?.title === 'Agent Cowork' &&
        windowsResourceDesktopLayout?.protocol === 'file:' &&
        windowsResourceDesktopLayout?.hostApi === false &&
        hasReferenceFunctionalShell(windowsResourceDesktopLayout) &&
        windowsResourceCompactLayout?.issues?.length === 0 &&
        windowsResourceInteraction?.afterPlan?.status === '预览模式' &&
        windowsResourceInteraction?.afterApprove?.status === '预览已应用' &&
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
    requirement('fresh-current-repo-evidence', 'All contributing evidence reports are fresh (<10min) and from the current repo (strict gate)', evidenceFresh ? 'passed' : 'failed', {
      staleThresholdMs: STALE_MS,
      repoRoot,
      issues: evidenceIssues,
    }),
    requirement('native-windows-window-smoke', 'Native Windows C client window-level smoke', nativePassed ? 'passed' : nativeBlocked ? 'blocked' : 'failed', {
      readinessReportPath: readinessFile,
      windowsVerificationReportPath: windowsVerification.ok ? windowsVerificationFile : null,
      executable: readiness.value?.executable,
      executableExists: readiness.value?.executableExists,
      readyToRunNativeSmoke: readiness.value?.readyToRunNativeSmoke,
      blockedByAsr: readiness.value?.blockedByAsr,
      exactExclusionRequired: readiness.value?.exactExclusionRequired,
      diagnosis: readiness.value?.diagnosis,
      defender: readiness.value?.defender,
      latestMatchingAsrEvent: readiness.value?.latestMatchingAsrEvent
        ? {
            timeCreated: readiness.value.latestMatchingAsrEvent.timeCreated,
            id: readiness.value.latestMatchingAsrEvent.id,
            providerName: readiness.value.latestMatchingAsrEvent.providerName,
          }
        : null,
      explicitApprovalText: readiness.value?.explicitApprovalText,
      proposedUnblockCommand: readiness.value?.proposedUnblockCommand,
      rerunCommand: readiness.value?.rerunCommand,
      fullVerificationCommand: readiness.value?.fullVerificationCommand,
      strictAuditCommand: readiness.value?.strictAuditCommand,
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
  // The evidence-freshness requirement is a STRICT-only gate, so it must not
  // affect the regular (non-strict) ok/exit semantics.
  const failed = requirements.filter((item) => item.status === 'failed' && item.id !== 'fresh-current-repo-evidence');

  const report = {
    ok: webHostMvpReady && failed.length === 0,
    completeGoal: webHostMvpReady && nativeWindowsReady,
    // In strict mode the gate additionally requires fresh, current-repo evidence.
    strictReady: webHostMvpReady && nativeWindowsReady && evidenceFresh,
    generatedAt: new Date().toISOString(),
    repoRoot,
    reportPath,
    summary: {
      passed: requirements.filter((item) => item.status === 'passed').length,
      failed: failed.length,
      blocked: blocked.length,
      webHostMvpReady,
      nativeWindowsReady,
      evidenceFresh,
      evidenceIssues,
    },
    requirements,
  };

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));

  if (strict && (!report.completeGoal || !evidenceFresh)) {
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
