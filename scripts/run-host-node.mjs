#!/usr/bin/env node
// TS 加载器引导入口:注册 ESM 钩子后再跑 TS CLI 包装器(scripts · 工具库)
// ---------------------------------------------------------------------------
// 职责:用 register() 把 host-ts-loader.mjs 挂为全局 ESM 加载器,使后续 .ts 可直接
//       运行。普通模式下随即 import ./run-host-node.ts(真正的 CLI 包装器);子进程
//       带 ?register-only=1 导入本文件时则只装加载器、不跑入口。
// 用法:被编译为 scripts/run-host-node.mjs,由 run-host-node.ts 通过 --import 预载。
// 依赖:host-ts-loader.mjs(同目录构建产物)。
//
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const currentUrl = new URL(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(currentUrl)), '..');
const loaderUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'host-ts-loader.mjs'));
const runnerScript = './run-host-node.ts';
register(loaderUrl, pathToFileURL(`${repoRoot}${path.sep}`));
// Normal mode runs the TS CLI wrapper. Child Node processes import this same
// file with ?register-only=1 so they only install the TS loader before running
// their own entrypoint.
if (!currentUrl.searchParams.has('register-only')) {
    await import(runnerScript);
}
