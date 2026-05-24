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
  checks: SelfCheckItem[];
}

export async function getSelfCheck(): Promise<SelfCheckResult> {
  return getJson('/api/selfcheck');
}
