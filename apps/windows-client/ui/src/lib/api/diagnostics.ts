// 诊断 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:拉取 host 自检结果(安全头/CORS/限流/熔断器/存储/沙箱等运维信息)。
// 依赖/对应路由:GET /api/selfcheck。导出:getSelfCheck + SelfCheckResult / SelfCheckItem 类型。
import { getJson } from './transport';

export interface SelfCheckItem {
  id: string;
  status: 'pass' | 'warn';
  detail: string;
}

export interface SelfCheckResult {
  service: string;
  time: string;
  security: {
    responseHeaders: string[];
    cors: string;
    apiKey: { configured: boolean; hasKey: boolean };
    bodyLimitBytes: number;
  };
  resilience: {
    rateLimit: { enabled: boolean; ratePerSec?: number; burst?: number; tenants?: number };
    concurrency: { active: number; tenants: number; maxConcurrent: number; maxPerTenant: number };
    modelBreakers: Array<{ name: string; state: string; trips?: number }>;
    draining: boolean;
  };
  storage: { backend: string; postgres: boolean };
  sandbox: {
    enabled: boolean;
    backend: string | null;
    networkIsolated: boolean;
    startup?: {
      selectedBackend: string;
      fallback: boolean;
      userMessage: string;
      fallbackReason?: string | null;
    } | null;
  };
  checks: SelfCheckItem[];
}

export async function getSelfCheck(): Promise<SelfCheckResult> {
  return getJson('/api/selfcheck');
}
