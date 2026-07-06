// 数据销毁 + 保留期(host · L1 security · data-purge)
// ---------------------------------------------------------------------------
// 职责:企业机密档要能"彻底、可控地抹掉本机工作区数据"。提供:
//   · buildPurgePlan —— 纯函数,列出将删除的目标(按 scope),严格 jail 在 .AgentCowork 内,
//     绝不触盘,供 UI 二次确认;
//   · executePurgePlan —— 真删,confirm 门控 + 逐目标复核 jail(防被篡改的计划越界删除);
//   · applyRetention —— 按 mtime 清理超过 N 天的 run 记录/对话(保留期策略)。
// 依赖:node:fs/path。语义:只删 .AgentCowork 内;越界即抛错拒绝。
import fs from 'node:fs';
import path from 'node:path';

const APP_DIR = '.AgentCowork';

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

function appDirOf(trustedRoot: string): string {
  return path.join(path.resolve(trustedRoot), APP_DIR);
}

function isInsideJail(targetPath: string, jail: string): boolean {
  const resolved = path.resolve(targetPath);
  const jailResolved = path.resolve(jail);
  return resolved === jailResolved || resolved.startsWith(jailResolved + path.sep);
}

function dirBytes(target: string): number {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const cur = stack.pop() as string;
    let stat: fs.Stats;
    try { stat = fs.statSync(cur); } catch { continue; }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(cur)) stack.push(path.join(cur, name));
    } else {
      total += stat.size;
    }
  }
  return total;
}

function targetFor(appDir: string, rel: string): PurgeTarget | null {
  const full = path.join(appDir, rel);
  if (!fs.existsSync(full)) return null;
  return { rel, path: full, bytes: dirBytes(full) };
}

/** 纯函数:按 scope 列出将删除的目标(jail 在 .AgentCowork 内),不触盘。 */
export function buildPurgePlan(trustedRoot: string, { scope }: { scope: PurgeScope }): PurgePlan {
  const appDir = appDirOf(trustedRoot);
  let targets: PurgeTarget[] = [];
  if (scope === 'everything') {
    targets = fs.existsSync(appDir) ? [{ rel: APP_DIR, path: appDir, bytes: dirBytes(appDir) }] : [];
  } else {
    const rels = scope === 'content' ? CONTENT_DIRS : [scope];
    targets = rels.map((rel) => targetFor(appDir, rel)).filter((t): t is PurgeTarget => t !== null);
  }
  // 防御性:确保每个目标都在 jail 内(理论上一定成立,这里显式过滤)。
  targets = targets.filter((t) => isInsideJail(t.path, appDir) || path.resolve(t.path) === appDir);
  return { trustedRoot: path.resolve(trustedRoot), appDir, scope, targets, executed: false };
}

/** 执行销毁:必须 confirm=true;逐目标复核 jail,越界即抛错拒绝整个操作。 */
export function executePurgePlan(plan: PurgePlan, { confirm }: { confirm: boolean }): { removed: string[] } {
  if (!confirm) return { removed: [] };
  const jail = plan.scope === 'everything' ? path.dirname(plan.appDir) : plan.appDir;
  const removed: string[] = [];
  for (const target of plan.targets) {
    const inJail = plan.scope === 'everything'
      ? path.resolve(target.path) === path.resolve(plan.appDir)
      : isInsideJail(target.path, plan.appDir);
    if (!inJail) {
      throw new Error(`data-purge: target escaped jail (${target.path}); refusing to delete outside ${jail}`);
    }
    fs.rmSync(target.path, { recursive: true, force: true });
    removed.push(target.path);
  }
  return { removed };
}

/** 保留期:删除 mtime 早于 (now - maxAgeDays) 的 run 记录与对话文档。 */
export function applyRetention(
  trustedRoot: string,
  { maxAgeDays, now = new Date() }: { maxAgeDays: number; now?: Date },
): { removed: string[] } {
  const appDir = appDirOf(trustedRoot);
  const cutoff = now.getTime() - Math.max(0, maxAgeDays) * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  const roots = [path.join(appDir, 'runs'), path.join(appDir, 'conversations')];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop() as string;
      let stat: fs.Stats;
      try { stat = fs.statSync(cur); } catch { continue; }
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(cur)) stack.push(path.join(cur, name));
      } else if (cur.endsWith('.json') && stat.mtime.getTime() < cutoff) {
        if (!isInsideJail(cur, appDir)) continue;
        try { fs.rmSync(cur, { force: true }); removed.push(cur); } catch { /* 单个删除失败不中断 */ }
      }
    }
  }
  return { removed };
}
