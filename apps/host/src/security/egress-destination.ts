// Strict local/external classification for egress reporting (host L0 security).
// A parsed destination is authoritative; provider ids are only a fallback when
// no destination was recorded, so a local-looking provider cannot mask a URL.

const LOCAL_PROVIDER_IDS = new Set([
  'local',
  'local-openai',
  'openai/local',
  'ollama',
  'lmstudio',
  'lm-studio',
  'local-lmstudio',
  'local-vllm',
  'vllm/local',
]);

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return host === 'localhost'
    || host === '::1'
    || host === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/u.test(host);
}

export function isLocalEgressDestination(destination: unknown, provider: unknown): boolean {
  const rawDestination = String(destination || '').trim();
  if (rawDestination) {
    try {
      const parsed = new URL(rawDestination);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      return isLoopbackHostname(parsed.hostname);
    } catch {
      return false;
    }
  }
  return LOCAL_PROVIDER_IDS.has(String(provider || '').trim().toLowerCase());
}
