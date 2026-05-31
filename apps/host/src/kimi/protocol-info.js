// @ts-check
// Kimi CLI 输出解析(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:把 `kimi --version` / `kimi info` 的纯文本输出解析成结构化字段
//       (版本号、线协议、Python 版本)。纯函数,无 I/O,便于单测。
// 依赖:仅标准库。
// 导出:parseKimiVersion、parseKimiInfo(及 KimiInfo typedef)。

/** 从 --version 文本中提取版本号,解析不出则抛错。 @param {unknown} text @returns {string} */
export function parseKimiVersion(text) {
  const raw = String(text ?? '').trim();
  const match = raw.match(/version\s+([0-9]+(?:\.[0-9]+){0,3})/i);
  if (!match) {
    throw new Error(`Unable to parse kimi --version output: ${raw}`);
  }
  return match[1];
}

/**
 * @typedef {{ version?: string, wireProtocol?: string, pythonVersion?: string, cli?: string }} KimiInfo
 */

/** 逐行解析 `kimi info` 的 key:value,提取版本/线协议/Python 版本。 @param {unknown} text @returns {KimiInfo} */
export function parseKimiInfo(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim());
  const data = /** @type {KimiInfo} */ ({});
  for (const line of lines) {
    const parts = line.split(':');
    if (parts.length < 2) {
      continue;
    }
    const key = parts[0].trim().toLowerCase();
    const value = parts.slice(1).join(':').trim();
    if (!value) {
      continue;
    }
    if (key === 'kimi-cli version' || key === 'kimi-cli version'.toLowerCase() || key === 'version') {
      data.version = value;
    }
    if (key === 'wire protocol') {
      data.wireProtocol = value;
    }
    if (key === 'python version') {
      data.pythonVersion = value;
    }
  }

  if (!data.version && data.cli) {
    data.version = data.cli;
  }
  return data;
}
