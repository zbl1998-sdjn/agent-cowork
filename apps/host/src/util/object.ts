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
