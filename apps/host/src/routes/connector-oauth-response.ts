// GitHub OAuth completion DTO boundary (host · L3 · routes).
// Rebuild response objects from strict primitive-only connector/security DTOs.
import { githubViewerDto } from '../connectors/oauth-github.js';
import { credentialSummaryDto } from '../security/credential-persistence.js';
import type { GitHubViewer } from '../connectors/oauth-github.js';
import type { CredentialSummary } from '../security/credential-store.js';

type RouteError = Error & { statusCode?: number };

export function githubOAuthCompletionDto(
  accountInput: unknown,
  credentialInput: unknown,
): { account: GitHubViewer; credential: CredentialSummary } {
  const credential = credentialSummaryDto(credentialInput);
  if (!credential) {
    const error = new Error('OAuth credential summary DTO is invalid') as RouteError;
    error.statusCode = 502;
    throw error;
  }
  return {
    account: githubViewerDto(accountInput),
    credential,
  };
}
