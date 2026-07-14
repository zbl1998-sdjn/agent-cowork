// Env var rename compatibility (host · L0 util)
// ---------------------------------------------------------------------------
// 职责:统一实现「新变量名优先、缺失时按顺序回退旧变量名」的读取规则,支撑
//       KCW_*/KIMI_* -> ACW_*/ACW_MODEL_* 的改名过渡,不让既有 .env/部署配置失效。
// 依赖:仅标准库(不依赖任何 process.env 具体值,由调用方传入 env 对象)。

/**
 * 按优先级读取环境变量:存在(即便是空字符串)就立即采用该变量的值,不再往下退;
 * 用 hasOwnProperty 判断存在性而非 `||`,因此显式设的空值也能正确覆盖旧变量。
 */
export function readCompatEnv(
  env: Record<string, string | undefined>,
  primary: string,
  ...legacy: string[]
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(env, primary)) {
    return env[primary];
  }
  for (const name of legacy) {
    if (Object.prototype.hasOwnProperty.call(env, name)) {
      return env[name];
    }
  }
  return undefined;
}
