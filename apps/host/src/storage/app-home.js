// @ts-check

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

/** @returns {string} */
function resolveDefaultHome() {
  if (process.env.AGENT_COWORK_HOME) {
    return path.resolve(process.env.AGENT_COWORK_HOME);
  }

  const fallbackCandidates = [];
  if (process.platform === 'win32' && process.env.APPDATA) {
    fallbackCandidates.push(path.resolve(process.env.APPDATA, 'AgentCowork'));
  }
  fallbackCandidates.push(path.resolve(process.cwd(), '.AgentCowork'));
  fallbackCandidates.push(path.resolve(os.tmpdir(), 'AgentCowork'));

  for (const candidate of fallbackCandidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch {
      // try next fallback
    }
  }

  return path.resolve(process.cwd(), '.AgentCowork');
}

/** @returns {string} */
export function getAppHome() {
  const home = resolveDefaultHome();
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/** @param {string} sessionId @returns {string} */
export function getSessionPath(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('Session id must be a non-empty string');
  }
  return path.join(getAppHome(), 'sessions', sessionId);
}
