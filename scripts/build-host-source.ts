// 仅编译 host TypeScript 源码到 build/host-src(scripts · 构建)
// ---------------------------------------------------------------------------
// 职责:校验 host 类型覆盖后,清空并重建 build/host-src 输出目录,再用
//       tsconfig.host-build.json 把 apps/host/src 编译成 JS(不打包、不做 SEA)。
// 用法:npm run build:host-src;也是 build-host.ts 完整 SEA 链路的第一步对应逻辑。
// 依赖:host-ts-support.js(类型覆盖断言、tsc 调用、仓库根/配置路径)。
import fs from 'node:fs';
import path from 'node:path';
import {
  assertHostTypeCoverage,
  hostBuildConfigPath,
  repoRoot,
  runTypeScriptProject,
} from './host-ts-support.js';

const outDir = path.join(repoRoot, 'build', 'host-src');

function assertBuildOutputPath(dir: string): void {
  const relative = path.relative(path.join(repoRoot, 'build'), dir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`[build-host-source] refusing to clean outside build/: ${dir}`);
  }
}

assertHostTypeCoverage();
assertBuildOutputPath(outDir);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

process.exit(runTypeScriptProject(hostBuildConfigPath));
