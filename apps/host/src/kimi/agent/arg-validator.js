// @ts-check
// 工具参数的轻量 JSON Schema 校验器(host · L1 领域层 · kimi/agent)
// ---------------------------------------------------------------------------
// 职责:在执行工具前,用工具自带的 parameters schema 校验模型给出的参数,
//      支持 type/required/properties/items/enum/additionalProperties 子集;
//      不合法即返回错误清单,挡住格式错误的调用。
// 依赖:仅标准库(无外部依赖)。
// 导出:validateToolArguments(顶层入口,返回 { valid, errors })
/**
 * @typedef {{ valid: boolean, errors: string[] }} ValidationResult
 * @typedef {{
 *   type?: string | string[],
 *   required?: string[],
 *   properties?: Record<string, JsonSchemaLike>,
 *   items?: JsonSchemaLike,
 *   enum?: unknown[],
 *   additionalProperties?: boolean | JsonSchemaLike,
 * }} JsonSchemaLike
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** @param {string} base @param {string} key @returns {string} */
function childPath(base, key) {
  return base ? `${base}.${key}` : key;
}

/**
 * @param {unknown} expected
 * @returns {string[]}
 */
function normalizeTypes(expected) {
  if (Array.isArray(expected)) return expected.map(String);
  if (typeof expected === 'string' && expected) return [expected];
  return [];
}

/**
 * @param {string} type
 * @param {unknown} value
 */
function matchesType(type, value) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isRecord(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return true;
}

/**
 * @param {JsonSchemaLike} schema
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} errors
 */
function validateValue(schema, value, path, errors) {
  if (!isRecord(schema)) return;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${path || 'value'} must be one of the declared enum values`);
    return;
  }

  const inferredType = schema.type || (schema.properties ? 'object' : schema.items ? 'array' : '');
  const types = normalizeTypes(inferredType);
  if (types.length && !types.some((type) => matchesType(type, value))) {
    errors.push(`${path || 'value'} must be ${types.join(' or ')}`);
    return;
  }

  if ((types.includes('object') || schema.properties) && isRecord(value)) {
    validateObject(schema, value, path, errors);
  }
  if ((types.includes('array') || schema.items) && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateValue(schema.items || {}, item, `${path}[${index}]`, errors));
  }
}

/**
 * @param {JsonSchemaLike} schema
 * @param {Record<string, unknown>} value
 * @param {string} path
 * @param {string[]} errors
 */
function validateObject(schema, value, path, errors) {
  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      errors.push(`${childPath(path, key)} is required`);
    }
  }
  for (const [key, child] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      validateValue(child, value[key], childPath(path, key), errors);
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push(`${childPath(path, key)} is not allowed`);
      }
    }
  }
}

/**
 * 校验工具参数是否符合给定 schema;无有效 schema 时一律放行。
 * @param {unknown} schema
 * @param {unknown} args
 * @returns {ValidationResult}
 */
export function validateToolArguments(schema, args) {
  if (!isRecord(schema)) return { valid: true, errors: [] };
  /** @type {string[]} */
  const errors = [];
  validateValue(/** @type {JsonSchemaLike} */ (schema), args, '', errors);
  return { valid: errors.length === 0, errors };
}
