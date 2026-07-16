// Ollama Cloud 一键接入(host · L1 领域层 · engine/provider)
// ---------------------------------------------------------------------------
// 职责:让非技术用户零配置用上云端大模型——`ollama signin` 走浏览器设备配对拿到
//       ollama.com 授权后,云端模型(带 -cloud/:cloud 后缀)仍通过本机 127.0.0.1:11434
//       同一 API 调用(出站策略已按 local 放行)。本模块只安全 spawn 固定的 ollama 子命令
//       (execFile,shell:false;pull 的模型名严格校验后缀+字符集,杜绝命令注入)。
// 依赖:node:child_process/fs/path/os/util。
// 导出:resolveOllamaBinary、ollamaSignin、ollamaPullCloud、isCloudModelName、RECOMMENDED_CLOUD_MODELS。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// UI 快捷推荐(会随 Ollama 目录变化;取不到时用户仍可自行 pull,pull 只按后缀校验不限于此列表)。
export const RECOMMENDED_CLOUD_MODELS: readonly string[] = Object.freeze([
  'gpt-oss:20b-cloud',
  'gpt-oss:120b-cloud',
  'qwen3.5:9b-cloud',
  'deepseek-v4-flash:cloud',
  'kimi-k2.7-code:cloud',
]);

const CLOUD_MODEL_RE = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/i;
const CONNECT_URL_RE = /https:\/\/ollama\.com\/connect\?[^\s]+/;

/** 云端模型名校验:形如 name:tag,且以 cloud 结尾(-cloud / :cloud),字符集受限。 */
export function isCloudModelName(model: unknown): model is string {
  const value = String(model || '').trim();
  if (!CLOUD_MODEL_RE.test(value) || value.length > 128) return false;
  return value.endsWith('-cloud') || value.endsWith(':cloud');
}

/** 定位 ollama 可执行文件:常见安装路径优先,退回 PATH。找不到返回 null。 */
export function resolveOllamaBinary(env: Record<string, string | undefined> = process.env): string | null {
  const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  const candidates = [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Ollama', exe),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Ollama', exe),
    process.platform === 'darwin' ? '/usr/local/bin/ollama' : null,
    process.platform === 'linux' ? '/usr/local/bin/ollama' : null,
    process.platform === 'linux' ? '/usr/bin/ollama' : null,
    path.join(os.homedir(), '.ollama', 'bin', exe),
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* 试下一个 */ }
  }
  return exe; // 退回裸命令名,交给 PATH 解析;真不存在时 spawn 会报错并被上层捕获。
}

export type OllamaSigninResult = { connectUrl: string | null; output: string };

/**
 * 运行 `ollama signin`:它会尝试打开浏览器并打印设备配对 URL。捕获输出提取该 URL 返回给
 * 前端兜底展示。signin 打印 URL 后即便进程被超时结束也不影响配对(密钥已落盘),故用较短超时。
 */
export async function ollamaSignin(env: Record<string, string | undefined> = process.env): Promise<OllamaSigninResult> {
  const bin = resolveOllamaBinary(env);
  let output = '';
  try {
    const { stdout, stderr } = await execFileAsync(bin, ['signin'], { timeout: 8000, windowsHide: true });
    output = `${stdout || ''}${stderr || ''}`;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    output = `${e.stdout || ''}${e.stderr || ''}` || String(e.message || '');
  }
  const match = CONNECT_URL_RE.exec(output);
  return { connectUrl: match ? match[0] : null, output: output.trim() };
}

/** 拉取一个云端模型(严格校验后缀/字符集后 execFile,shell:false)。失败抛错由上层转 4xx/5xx。 */
export async function ollamaPullCloud(model: string, env: Record<string, string | undefined> = process.env): Promise<{ model: string; output: string }> {
  if (!isCloudModelName(model)) {
    const err = new Error(`不是合法的云端模型名(需以 -cloud/:cloud 结尾): ${model}`) as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }
  const bin = resolveOllamaBinary(env);
  const { stdout, stderr } = await execFileAsync(bin, ['pull', model], { timeout: 600000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return { model, output: `${stdout || ''}${stderr || ''}`.trim() };
}
