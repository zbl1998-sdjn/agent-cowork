export function parseKimiVersion(text) {
  const raw = String(text ?? '').trim();
  const match = raw.match(/version\s+([0-9]+(?:\.[0-9]+){0,3})/i);
  if (!match) {
    throw new Error(`Unable to parse kimi --version output: ${raw}`);
  }
  return match[1];
}

export function parseKimiInfo(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim());
  const data = {};
  for (const line of lines) {
    const parts = line.split(':');
    if (parts.length < 2) {
      continue;
    }
    const key = parts[0].trim().toLowerCase();
    const value = parts.slice(1).join(':').trim();
    if (!value) {
      continue;
    }
    if (key === 'kimi-cli version' || key === 'kimi-cli version'.toLowerCase() || key === 'version') {
      data.version = value;
    }
    if (key === 'wire protocol') {
      data.wireProtocol = value;
    }
    if (key === 'python version') {
      data.pythonVersion = value;
    }
  }

  if (!data.version && data.cli) {
    data.version = data.cli;
  }
  return data;
}
