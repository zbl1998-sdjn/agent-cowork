// @ts-check
// 解析应用主目录与会话目录路径(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:确定 Agent Cowork 的数据根目录(优先环境变量,其次平台默认/临时目录回退),
//       并据此拼出单个会话的存储路径,目录不存在时自动创建。
// 依赖:仅标准库(os/fs/path)。
// 导出:getAppHome()(返回数据根目录) · getSessionPath(sessionId)(返回会话目录)。

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

/** 按优先级解析数据根目录:环境变量 > Windows APPDATA > 当前目录 > 临时目录。 @returns {string} */
function resolveDefaultHome() {
  if (process.env.AGENT_COWORK_HOME) {
    return path.resolve(process.env.AGENT_COWORK_HOME);
  }

  const fallbackCandidates = [];
  if (process.platform === 'win32' && process.env.APPDATA) {
    fallbackCandidates.push(path.resolve(process.env.APPDATA, 'AgentCowork'));
  }
  fallbackCandidates.push(path.resolve(process.cwd(), '.AgentCowork'));
  fallbackCandidates.push(path.resolve(os.tmpdir(), 'AgentCowork'));

  for (const candidate of fallbackCandidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch {
      // try next fallback
    }
  }

  return path.resolve(process.cwd(), '.AgentCowork');
}

/** 返回应用数据根目录(确保已创建)。 @returns {string} */
export function getAppHome() {
  const home = resolveDefaultHome();
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/** 返回指定会话在数据根目录下的存储路径。 @param {string} sessionId @returns {string} */
export function getSessionPath(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('Session id must be a non-empty string');
  }
  return path.join(getAppHome(), 'sessions', sessionId);
}
