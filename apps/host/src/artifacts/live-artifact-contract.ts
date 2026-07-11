// Live artifact wire contract (host · L1 artifacts).
// Explicit markers keep ordinary HTML/JSON from being inferred as executable live artifacts.
export const LIVE_ARTIFACT_TYPE = 'live-artifact' as const;
export const LIVE_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const LIVE_ARTIFACT_HTML_SENTINEL = '<!-- agent-cowork-live-artifact:v1 -->' as const;

const LIVE_ARTIFACT_HTML_PREFIX = `<!doctype html>\n${LIVE_ARTIFACT_HTML_SENTINEL}\n`;

export function hasLiveArtifactHtmlSentinel(html: string): boolean {
  return html.startsWith(LIVE_ARTIFACT_HTML_PREFIX);
}
