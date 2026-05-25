// @ts-check

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function cleanProvider(value) {
  return cleanText(value).toLowerCase();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function cleanBaseUrl(value) {
  return cleanText(value).replace(/\/+$/, '');
}

/**
 * @param {unknown} body
 * @returns {{ provider?: string, model?: string, baseUrl?: string, apiKey?: string }}
 */
function requestModelConfig(body) {
  const request = objectOrEmpty(body);
  const nested = objectOrEmpty(request.modelConfig || request.kimiConfig);
  const source = Object.keys(nested).length ? nested : request;
  const out = /** @type {{ provider?: string, model?: string, baseUrl?: string, apiKey?: string }} */ ({});
  const provider = cleanProvider(source.provider || source.modelProvider || source.kimiProvider);
  const model = cleanText(source.model);
  const baseUrl = cleanBaseUrl(source.baseUrl || source.apiBaseUrl);
  const apiKey = cleanText(source.apiKey || source.modelApiKey || source.kimiApiKey);
  if (provider) out.provider = provider;
  if (model) out.model = model;
  if (baseUrl) out.baseUrl = baseUrl;
  if (apiKey) out.apiKey = apiKey;
  return out;
}

/**
 * Builds a per-request model config without mutating or persisting the host
 * default. Only scalar model routing fields are accepted; fallback chains stay
 * host-managed so request bodies cannot smuggle secret fallback layers.
 *
 * @param {unknown} kimiConfig
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
export function applySessionModelConfig(kimiConfig, body) {
  const base = { ...objectOrEmpty(kimiConfig) };
  const override = requestModelConfig(body);
  return Object.keys(override).length ? { ...base, ...override } : base;
}

/**
 * @param {unknown} body
 * @returns {boolean}
 */
export function hasSessionModelAccess(body) {
  const override = requestModelConfig(body);
  if (override.apiKey) return true;
  return override.provider === 'openai/local' || override.provider === 'local-openai';
}
