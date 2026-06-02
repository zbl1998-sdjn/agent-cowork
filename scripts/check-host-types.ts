// host 源码类型检查 + tsconfig 覆盖校验(scripts · 门禁(gate))
// ---------------------------------------------------------------------------
// 职责:先断言 tsconfig.host-checkjs.json 的 files 列表覆盖 apps/host/src 下每个
//   .js/.ts 源(漏配或残留失效条目即失败),再用该 tsconfig 跑一遍 tsc 类型检查。
//   两步逻辑均委托给 ./host-ts-support.ts 的 assertHostTypeCoverage 与
//   runTypeScriptProject;本文件只做入口编排并 re-export findHostTypeCoverageIssues
//   供测试调用。
// 用法:npm run check:host-types(经 run-host-node.mjs 运行),也是 npm run check
//   聚合门禁的一环。
// 依赖:scripts/host-ts-support.ts、本地 typescript 编译器;失败(覆盖缺口或类型
//   错误)即以 tsc 退出码 exit 阻断。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertHostTypeCoverage,
  findHostTypeCoverageIssues,
  hostCheckConfigPath,
  runTypeScriptProject,
} from './host-ts-support.js';

export { findHostTypeCoverageIssues };

function runMain(): never {
  assertHostTypeCoverage();
  process.exit(runTypeScriptProject(hostCheckConfigPath));
}

const invokedAsMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (invokedAsMain) runMain();
