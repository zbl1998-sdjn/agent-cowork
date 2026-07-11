// Reserved live-artifact contract guard (host · L1 artifacts).
// Generic workspace writes and rollbacks may manage ordinary artifacts, but live
// artifact versions are write-once and may only be created by the version publisher.
import fs from 'node:fs';
import path from 'node:path';

import {
  LIVE_ARTIFACT_HTML_SENTINEL,
  LIVE_ARTIFACT_TYPE,
} from './live-artifact-contract.js';

function immutableLiveArtifactConflict(): Error & { statusCode: number } {
  const error = new Error(
    'live artifact versions are immutable; create a new version instead',
  ) as Error & { statusCode: number };
  error.statusCode = 409;
  return error;
}

function hasReservedLiveArtifactContract(artifactPath: string, content: string | Buffer): boolean {
  const extension = path.extname(artifactPath).toLowerCase();
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : content;
  if (extension === '.html' || extension === '.htm') {
    return text.includes(LIVE_ARTIFACT_HTML_SENTINEL);
  }
  if (extension !== '.json') return false;
  try {
    const parsed = JSON.parse(text) as unknown;
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).artifactType === LIVE_ARTIFACT_TYPE);
  } catch {
    return /["']artifactType["']\s*:\s*["']live-artifact["']/u.test(text);
  }
}

export function assertNoLiveArtifactMutation(
  artifactPath: string,
  nextContent?: string | Buffer,
): void {
  if (fs.existsSync(artifactPath)
    && hasReservedLiveArtifactContract(artifactPath, fs.readFileSync(artifactPath))) {
    throw immutableLiveArtifactConflict();
  }
  if (nextContent !== undefined && hasReservedLiveArtifactContract(artifactPath, nextContent)) {
    throw immutableLiveArtifactConflict();
  }
}
