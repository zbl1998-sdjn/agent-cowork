// 数据销毁 + 保留期(host · L1 security · data-purge)
// ---------------------------------------------------------------------------
// 职责:企业机密档要能"彻底、可控地抹掉本机工作区数据"。提供:
//   · buildPurgePlan —— 纯函数,列出将删除的目标(按 scope),严格 jail 在 .AgentCowork 内,
//     绝不触盘,供 UI 二次确认;
//   · executePurgePlan —— 真删,confirm 门控 + 逐目标复核 jail(防被篡改的计划越界删除);
//   · applyRetention —— 按 mtime 清理超过 N 天的 run 记录/对话(保留期策略)。
// 依赖:node:fs/path。语义:只删 .AgentCowork 内;越界即抛错拒绝。
import path from 'node:path';
import {
  APP_DIR,
  createPurgeBoundary,
  inspectPurgePath,
  listPurgeDirectory,
  purgePathBytes,
  removePurgeTree,
  revalidatePurgePath,
  samePurgePath,
  type PurgeBoundary,
} from './data-purge-filesystem.js';

// content = 删全部业务内容但保留密钥箱与 config/auth(便于换密钥前先清数据);
// everything = 连 .AgentCowork 整个抹掉(含密钥,真正的一键归零)。
export const PURGE_SCOPES = ['conversations', 'runs', 'memory', 'content', 'everything'] as const;
export type PurgeScope = typeof PURGE_SCOPES[number];

export type PurgeTarget = { rel: string; path: string; bytes: number };
export type PurgePlan = {
  trustedRoot: string;
  appDir: string;
  scope: PurgeScope;
  targets: PurgeTarget[];
  executed: false;
};

const CONTENT_DIRS = ['conversations', 'runs', 'memory', 'index'];

function targetFor(boundary: PurgeBoundary, rel: string): PurgeTarget | null {
  const full = path.join(boundary.appDir, rel);
  if (!inspectPurgePath(full, boundary, { allowMissing: true })) return null;
  return { rel, path: full, bytes: purgePathBytes(full, boundary) };
}

/** 纯函数:按 scope 列出将删除的目标(jail 在 .AgentCowork 内),不触盘。 */
export function buildPurgePlan(trustedRoot: string, { scope }: { scope: PurgeScope }): PurgePlan {
  if (!PURGE_SCOPES.includes(scope)) throw new Error(`data-purge: invalid scope (${String(scope)})`);
  const boundary = createPurgeBoundary(trustedRoot);
  let targets: PurgeTarget[] = [];
  if (scope === 'everything') {
    targets = inspectPurgePath(boundary.appDir, boundary, { allowMissing: true })
      ? [{ rel: APP_DIR, path: boundary.appDir, bytes: purgePathBytes(boundary.appDir, boundary) }]
      : [];
  } else {
    const rels = scope === 'content' ? CONTENT_DIRS : [scope];
    targets = rels.map((rel) => targetFor(boundary, rel)).filter((t): t is PurgeTarget => t !== null);
  }
  return {
    trustedRoot: boundary.trustedRoot,
    appDir: boundary.appDir,
    scope,
    targets,
    executed: false,
  };
}

function allowedTargetRels(scope: PurgeScope): readonly string[] {
  if (scope === 'everything') return [APP_DIR];
  return scope === 'content' ? CONTENT_DIRS : [scope];
}

function validatedPlanTargets(plan: PurgePlan): { boundary: PurgeBoundary; targets: string[] } {
  if (!plan || typeof plan !== 'object' || !PURGE_SCOPES.includes(plan.scope)) {
    throw new Error('data-purge: invalid purge plan');
  }
  const boundary = createPurgeBoundary(plan.trustedRoot);
  if (!samePurgePath(plan.appDir, boundary.appDir)) {
    throw new Error('data-purge: plan appDir does not match trustedRoot jail');
  }
  const allowed = new Set(allowedTargetRels(plan.scope));
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const target of plan.targets) {
    if (!target || typeof target !== 'object' || !allowed.has(target.rel) || seen.has(target.rel)) {
      throw new Error('data-purge: plan contains an invalid, duplicate, or out-of-jail target');
    }
    seen.add(target.rel);
    const expectedPath = target.rel === APP_DIR
      ? boundary.appDir
      : path.join(boundary.appDir, target.rel);
    if (!samePurgePath(target.path, expectedPath)) {
      throw new Error(`data-purge: target escaped jail (${target.path})`);
    }
    targets.push(expectedPath);
  }
  return { boundary, targets };
}

/** 执行销毁:必须 confirm=true;逐目标复核 jail,越界即抛错拒绝整个操作。 */
export function executePurgePlan(plan: PurgePlan, { confirm }: { confirm: boolean }): { removed: string[] } {
  if (!confirm) return { removed: [] };
  const { boundary, targets } = validatedPlanTargets(plan);
  // 先完整预检所有目标,避免后置目标中的链接导致前置目标已被部分删除。
  for (const target of targets) {
    if (inspectPurgePath(target, boundary, { allowMissing: true })) purgePathBytes(target, boundary);
  }
  const removed: string[] = [];
  for (const target of targets) {
    if (removePurgeTree(target, boundary)) removed.push(target);
  }
  return { removed };
}

/** 保留期:删除 mtime 早于 (now - maxAgeDays) 的 run 记录与对话文档。 */
export function applyRetention(
  trustedRoot: string,
  { maxAgeDays, now = new Date() }: { maxAgeDays: number; now?: Date },
): { removed: string[] } {
  const boundary = createPurgeBoundary(trustedRoot);
  const cutoff = now.getTime() - Math.max(0, maxAgeDays) * 24 * 60 * 60 * 1000;
  const removed: string[] = [];

  function visit(candidatePath: string): void {
    const inspected = inspectPurgePath(candidatePath, boundary, { allowMissing: true });
    if (!inspected) return;
    if (inspected.stats.isDirectory()) {
      const names = listPurgeDirectory(candidatePath, boundary, inspected);
      for (const name of names) visit(path.join(candidatePath, name));
      return;
    }
    if (
      path.extname(candidatePath).toLowerCase() === '.json'
      && inspected.stats.mtime.getTime() < cutoff
    ) {
      revalidatePurgePath(candidatePath, boundary, inspected);
      if (removePurgeTree(candidatePath, boundary)) removed.push(candidatePath);
    }
  }

  for (const root of [
    path.join(boundary.appDir, 'runs'),
    path.join(boundary.appDir, 'conversations'),
  ]) {
    visit(root);
  }
  return { removed };
}
