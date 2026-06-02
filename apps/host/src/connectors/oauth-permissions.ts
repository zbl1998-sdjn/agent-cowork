// OAuth 权限(host · L1 领域层 · connectors)
// ---------------------------------------------------------------------------
// 职责:校验并归一化连接器声明的 OAuth 权限项(id/label/风险/默认勾选),供前端展示与授权选择。
//       最小权限原则:默认只勾必要项,高危项需用户显式选择。依赖:无。
// 导出:权限解析/校验相关函数。
//
type HttpError = Error & { statusCode?: number };

type OAuthPermissionInput = {
  id?: string;
  label?: string;
  description?: string;
  risk?: string;
  default?: boolean;
};

type OAuthConnector = {
  auth?: {
    permissions?: OAuthPermissionInput[];
    scopes?: string[];
  };
};

export type OAuthPermission = {
  id: string;
  label: string;
  description: string;
  risk: string;
  default: boolean;
};

function makeHttpError(statusCode: number, message: string): HttpError {
  const err = new Error(message) as HttpError;
  err.statusCode = statusCode;
  return err;
}

function rawRequestedScopes(scopes: unknown): string[] {
  const list = Array.isArray(scopes) ? scopes : String(scopes || '').split(/\s+/);
  return list.map((scope) => String(scope).trim()).filter(Boolean);
}

export function oauthPermissions(connector: OAuthConnector): OAuthPermission[] {
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

export function normalizeOAuthScopes(connector: OAuthConnector, requestedScopes: unknown): string[] {
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

export function selectedOAuthPermissions(connector: OAuthConnector, scopes: string[]): OAuthPermission[] {
  const selected = new Set(scopes || []);
  return oauthPermissions(connector).filter((permission) => selected.has(permission.id));
}
