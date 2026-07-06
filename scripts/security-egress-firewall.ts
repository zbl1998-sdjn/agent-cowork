// OS 级出网强制:防火墙规则计划发射器(plan-only,不执行、不需管理员)
// ---------------------------------------------------------------------------
// 用法:
//   node scripts/run-host-node.mjs scripts/security-egress-firewall.ts \
//     --exe "C:\Program Files\Agent Cowork\agent-cowork-desktop.exe" \
//     --allow 10.0.0.5 --allow 192.168.1.0/24
// 输出:把可审查的防火墙规则计划(+ 供管理员执行的 PowerShell 命令、回滚命令)写入
//   reports/security/egress-firewall-plan.json,并把命令打印到 stdout。
// 本脚本绝不改动本机防火墙;真正 apply 由管理员在提升权限的 PowerShell 中执行打印出的命令。
import fs from 'node:fs';
import path from 'node:path';
import { buildEgressFirewallPlan } from '../apps/host/src/security/egress-firewall.js';

function argValues(flag: string): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag && argv[i + 1]) { out.push(String(argv[i + 1])); i += 1; }
  }
  return out;
}

const exes = argValues('--exe');
const allow = argValues('--allow');
if (exes.length === 0) {
  console.error('[egress-firewall] 需要至少一个 --exe <app 可执行文件路径>');
  process.exit(1);
}

const plan = buildEgressFirewallPlan({ appExePaths: exes, allowHosts: allow });
const outDir = path.join(process.cwd(), 'reports', 'security');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'egress-firewall-plan.json');
fs.writeFileSync(outPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

console.log('=== Agent Cowork 隔离档出网强制:防火墙规则计划(未执行)===');
for (const w of plan.warnings) console.log(`[warn] ${w}`);
console.log('\n# 管理员在提升权限的 PowerShell 中执行以下命令建规:');
for (const c of plan.commands) console.log(c);
console.log('\n# 回滚(一把清除本组全部规则):');
console.log(plan.removeCommand);
console.log(`\nplan JSON: ${outPath}`);
