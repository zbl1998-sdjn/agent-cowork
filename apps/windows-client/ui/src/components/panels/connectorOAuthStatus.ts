import { getOAuthConnectorStatus, type ConnectorInfo } from '../../lib/api';

export type OAuthStatusView = {
  connected: boolean;
  accounts: string[];
  configured?: boolean;
  configurationMessage?: string;
  requiredEnv?: string[];
};

export async function readConnectorOAuthStatus(items: ConnectorInfo[]) {
  const oauthItems = items.filter((connector) => connector.auth?.type === 'oauth-device');
  const next: Record<string, OAuthStatusView> = {};
  await Promise.all(oauthItems.map(async (connector) => {
    try {
      const status = await getOAuthConnectorStatus(connector.id);
      next[connector.id] = {
        connected: status.connected,
        configured: status.configured,
        configurationMessage: status.configurationMessage,
        requiredEnv: status.requiredEnv,
        accounts: (status.accounts || []).map((account) => account.accountId),
      };
    } catch {
      next[connector.id] = { connected: false, accounts: [] };
    }
  }));
  return next;
}
