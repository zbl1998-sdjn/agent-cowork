// 对象工具:剔除 undefined 字段(host · L0 基础层 · util)
// ---------------------------------------------------------------------------
// 职责:提供 omitUndefined —— 删掉对象中值为 undefined 的键,并在类型层面把这些可选键
//       从必填收窄为可选(DefinedObject),便于安全构造 exactOptionalPropertyTypes 下的对象。
// 依赖:无。导出:DefinedObject(类型), omitUndefined。
type OptionalKey<T extends Record<string, unknown>> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never;
}[keyof T];

export type DefinedObject<T extends Record<string, unknown>> =
  Omit<T, OptionalKey<T>> & {
    [K in OptionalKey<T>]?: Exclude<T[K], undefined>;
  };

export function omitUndefined<T extends Record<string, unknown>>(input: T): DefinedObject<T> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output as DefinedObject<T>;
}
