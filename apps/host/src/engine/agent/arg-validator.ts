// 工具参数的轻量 JSON Schema 校验器(host · L1 领域层 · engine/agent)
// ---------------------------------------------------------------------------
// 职责:在执行工具前,用工具自带的 parameters schema 校验模型给出的参数,
//      支持 type/required/properties/items/enum/additionalProperties 子集;
//      不合法即返回错误清单,挡住格式错误的调用。
// 依赖:仅标准库(无外部依赖)。
// 导出:validateToolArguments(顶层入口,返回 { valid, errors })
export type ValidationResult = { valid: boolean; errors: string[] };
export type JsonSchemaLike = {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchemaLike>;
  items?: JsonSchemaLike;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchemaLike;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function childPath(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

function normalizeTypes(expected: unknown): string[] {
  if (Array.isArray(expected)) return expected.map(String);
  if (typeof expected === 'string' && expected) return [expected];
  return [];
}

/**
 * 校验一个值是否匹配 JSON Schema 的基础 type 子集。
 */
function matchesType(type: string, value: unknown): boolean {
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
 * 递归校验任意 schema 节点,把错误追加到 errors 中而不是抛异常。
 */
function validateValue(schema: JsonSchemaLike, value: unknown, path: string, errors: string[]): void {
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
 * 校验 object 节点的 required/properties/additionalProperties 约束。
 */
function validateObject(schema: JsonSchemaLike, value: Record<string, unknown>, path: string, errors: string[]): void {
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
 */
export function validateToolArguments(schema: unknown, args: unknown): ValidationResult {
  if (!isRecord(schema)) return { valid: true, errors: [] };
  const errors: string[] = [];
  validateValue(schema as JsonSchemaLike, args, '', errors);
  return { valid: errors.length === 0, errors };
}
