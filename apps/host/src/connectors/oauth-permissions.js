// @ts-check

/**
 * @typedef {Error & { statusCode?: number }} HttpError
 * @typedef {{ id?: string, label?: string, description?: string, risk?: string, default?: boolean }} OAuthPermissionInput
 * @typedef {{ auth?: { permissions?: OAuthPermissionInput[], scopes?: string[] } }} OAuthConnector
 * @typedef {{ id: string, label: string, description: string, risk: string, default: boolean }} OAuthPermission
 */

/**
 * @param {number} statusCode
 * @param {string} message
 * @returns {HttpError}
 */
function makeHttpError(statusCode, message) {
  const err = /** @type {HttpError} */ (new Error(message));
  err.statusCode = statusCode;
  return err;
}

/** @param {unknown} scopes */
function rawRequestedScopes(scopes) {
  const list = Array.isArray(scopes) ? scopes : String(scopes || '').split(/\s+/);
  return list.map((scope) => String(scope).trim()).filter(Boolean);
}

/**
 * @param {OAuthConnector} connector
 * @returns {OAuthPermission[]}
 */
export function oauthPermissions(connector) {
  const auth = connector?.auth || {};
  if (Array.isArray(auth.permissions) && auth.permissions.length > 0) {
    return auth.permissions.map((permission) => ({
      id: String(permission.id || '').trim(),
      label: String(permission.label || permission.id || '').trim(),
      description: String(permission.description || '').trim(),
      risk: String(permission.risk || 'low').trim().toLowerCase(),
      default: permission.default !== false,
    })).filter((permission) => permission.id);
  }
  return (auth.scopes || []).map((scope) => ({
    id: String(scope),
    label: String(scope),
    description: '',
    risk: 'low',
    default: true,
  }));
}

/**
 * @param {OAuthConnector} connector
 * @param {unknown} requestedScopes
 * @returns {string[]}
 */
export function normalizeOAuthScopes(connector, requestedScopes) {
  const permissions = oauthPermissions(connector);
  const allowed = new Set(permissions.map((permission) => permission.id));
  const requested = rawRequestedScopes(requestedScopes);
  const wanted = requested.length
    ? requested
    : permissions.filter((permission) => permission.default).map((permission) => permission.id);
  const unknown = wanted.filter((scope) => !allowed.has(scope));
  if (unknown.length > 0) {
    throw makeHttpError(400, `unsupported OAuth scope: ${unknown.join(', ')}`);
  }
  const selected = permissions
    .map((permission) => permission.id)
    .filter((scope) => wanted.includes(scope));
  if (selected.length === 0) {
    throw makeHttpError(400, 'at least one OAuth scope is required');
  }
  return selected;
}

/**
 * @param {OAuthConnector} connector
 * @param {string[]} scopes
 * @returns {OAuthPermission[]}
 */
export function selectedOAuthPermissions(connector, scopes) {
  const selected = new Set(scopes || []);
  return oauthPermissions(connector).filter((permission) => selected.has(permission.id));
}
