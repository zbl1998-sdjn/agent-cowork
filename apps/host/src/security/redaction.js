const SECRET_KEYWORDS = [
  /api[_-]?key/i,
  /api[_-]?token/i,
  /bearer\s+[a-z0-9._-]+/i,
  /authorization:\s*bearer\s+[a-z0-9._-]+/i,
  /secret/i,
];

const SENSITIVE_TOKENS = [
  /\b[A-Za-z0-9]{20,}\.[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{10,}[A-Za-z0-9._-]+\b/g,
  /(?:^|[\\\/])\.kimi[\\\/]credentials(?:[\\\/].*)?/gi,
  /(?:^|[\\\/])\.ssh(?:[\\\/].*)?/gi,
  /[\\\/]AppData[\\\/][^\\\/]*/gi,
];

function maskKnownPaths(value) {
  return SENSITIVE_TOKENS.reduce((acc, token) => acc.replace(token, '[REDACTED_PATH]'), value);
}

function maskKeyLikeValues(value) {
  let masked = value;
  for (const pattern of SECRET_KEYWORDS) {
    masked = masked.replace(pattern, '[REDACTED]');
  }
  return masked;
}

export function redactText(value) {
  if (value === undefined || value === null) {
    return value;
  }
  let text = String(value);
  text = maskKnownPaths(text);
  text = maskKeyLikeValues(text);
  return text;
}
