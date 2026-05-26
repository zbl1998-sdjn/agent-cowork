import type { ConnectorInfo, OAuthPermission } from '../../lib/api';

export function connectorPermissions(connector: ConnectorInfo): OAuthPermission[] {
  return connector.auth?.permissions || (connector.auth?.scopes || []).map((scope) => ({
    id: scope,
    label: scope,
    risk: 'low',
    default: true,
  }));
}

export function defaultConnectorScopes(connector: ConnectorInfo) {
  const defaults = connectorPermissions(connector)
    .filter((permission) => permission.default !== false)
    .map((permission) => permission.id);
  return defaults.length ? defaults : connector.auth?.scopes || [];
}

export function connectorScopeKey(scopes: string[]) {
  return [...scopes].sort().join('\n');
}
