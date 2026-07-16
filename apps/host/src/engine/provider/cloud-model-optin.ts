// 云端模型用户开关(host · L1 领域层 · engine/provider)
// ---------------------------------------------------------------------------
// 职责:把"是否启用某公网云 provider"从只能改的管理员环境变量,变成用户可视化、
//       按工作区持久化的开关(`.AgentCowork/settings/cloud-models.json`)。启用后
//       该 provider 的 API 主机被并入 gateway 放行名单,策略层(L0 model-gateway-policy
//       读同一环境变量)据此把它归类为 customer_gateway 放行——复用既有出站策略,
//       不新造安全通道。出站预览与 egress-audit 照常记录,状态条仍显示"使用云端模型"。
// 依赖:node:fs/path + 同层 provider 目录(取 provider→主机)。
// 导出:readCloudOptIn、setCloudOptIn、cloudOptInHosts、applyCloudOptInToEnv、
//       listCloudProviders、hostOf、GATEWAY_HOSTS_ENV。
import fs from 'node:fs';
import path from 'node:path';
import { defaultBaseUrlForProvider, findModelProviderCatalog, listModelProviderCatalog } from './catalog.js';

export const GATEWAY_HOSTS_ENV = 'ACW_CUSTOMER_MODEL_GATEWAY_HOSTS';

type HttpError = Error & { statusCode?: number };

export type CloudOptIn = { enabled: boolean; providers: string[] };

function settingsPath(trustedRoot: string): string {
  return path.join(path.resolve(trustedRoot), '.AgentCowork', 'settings', 'cloud-models.json');
}

/** provider 的 API 主机(取默认 baseUrl 的 hostname,小写去括号)。取不到返回空串。 */
export function hostOf(providerId: string): string {
  const base = defaultBaseUrlForProvider(providerId);
  if (!base) return '';
  try {
    return new URL(base).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  } catch {
    return '';
  }
}

/** 一个 provider 是否为"可作为云端开启"的公网 provider(排除本地回环与自定义占位)。 */
function isCloudProviderId(providerId: string): boolean {
  const entry = findModelProviderCatalog(providerId);
  if (!entry || entry.region === 'local' || entry.region === 'custom') return false;
  return Boolean(hostOf(providerId));
}

/** 读取本工作区的云端开关;文件缺失/损坏安全降级为关闭。非法/非云 provider 会被过滤。 */
export function readCloudOptIn(trustedRoot: string): CloudOptIn {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(trustedRoot), 'utf8')) as { enabled?: unknown; providers?: unknown };
    const providers = Array.isArray(raw?.providers)
      ? [...new Set(raw.providers.filter((p): p is string => typeof p === 'string' && isCloudProviderId(p)))].sort()
      : [];
    return { enabled: raw?.enabled === true, providers };
  } catch {
    return { enabled: false, providers: [] };
  }
}

/** 写入云端开关;providers 里的非云/非法项会被拒(400)。返回落盘后的规范值。 */
export function setCloudOptIn(trustedRoot: string, input: { enabled: unknown; providers: unknown }): CloudOptIn {
  const list = Array.isArray(input.providers) ? input.providers : [];
  const bad = list.find((p) => typeof p === 'string' && p && !isCloudProviderId(p));
  if (bad) {
    const err = new Error(`不是可启用的云端 provider: ${bad}`) as HttpError;
    err.statusCode = 400;
    throw err;
  }
  const providers = [...new Set(list.filter((p): p is string => typeof p === 'string' && isCloudProviderId(p)))].sort();
  const value: CloudOptIn = { enabled: input.enabled === true, providers };
  const file = settingsPath(trustedRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...value, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  return value;
}

/** 当前生效的用户放行主机(仅在 enabled 时展开为各 provider 主机)。 */
export function cloudOptInHosts(optIn: CloudOptIn): string[] {
  if (!optIn.enabled) return [];
  return [...new Set(optIn.providers.map(hostOf).filter(Boolean))];
}

/** 可在 UI 里作为"云端"开关列出的 provider(id/名称/主机)。 */
export function listCloudProviders(): Array<{ id: string; displayName: string; host: string }> {
  return listModelProviderCatalog()
    .filter((entry) => entry.region !== 'local' && entry.region !== 'custom' && hostOf(entry.id))
    .map((entry) => ({ id: entry.id, displayName: entry.displayName, host: hostOf(entry.id) }));
}

function splitHosts(value: string): string[] {
  return String(value || '').trim().split(/[,\s;]+/g).map((h) => h.trim().toLowerCase()).filter(Boolean);
}

/**
 * 把用户放行主机并入 gateway 环境变量,供既有策略(L0)读取。
 * baseline 是启动时抓取的管理员原始值(外部环境变量),用户开关只在其上叠加,
 * 关闭时回落到 baseline,绝不清掉管理员放行。返回最终写入的值。
 */
export function applyCloudOptInToEnv(
  trustedRoot: string,
  baseline: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const userHosts = cloudOptInHosts(readCloudOptIn(trustedRoot));
  const merged = [...new Set([...splitHosts(baseline), ...userHosts])];
  // 空串对策略等价于"未放行任何主机"(splitList 空串 → []),无需 delete。
  const value = merged.join(',');
  env[GATEWAY_HOSTS_ENV] = value;
  return value;
}
