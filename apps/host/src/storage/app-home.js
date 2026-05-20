import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

function resolveDefaultHome() {
  if (process.env.KIMI_COWORK_HOME) {
    return path.resolve(process.env.KIMI_COWORK_HOME);
  }

  const fallbackCandidates = [];
  if (process.platform === 'win32' && process.env.APPDATA) {
    fallbackCandidates.push(path.resolve(process.env.APPDATA, 'KimiCowork'));
  }
  fallbackCandidates.push(path.resolve(process.cwd(), '.KimiCowork'));
  fallbackCandidates.push(path.resolve(os.tmpdir(), 'KimiCowork'));

  for (const candidate of fallbackCandidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch {
      // try next fallback
    }
  }

  return path.resolve(process.cwd(), '.KimiCowork');
}

export function getAppHome() {
  const home = resolveDefaultHome();
  fs.mkdirSync(home, { recursive: true });
  return home;
}

export function getSessionPath(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('Session id must be a non-empty string');
  }
  return path.join(getAppHome(), 'sessions', sessionId);
}
