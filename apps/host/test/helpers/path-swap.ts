import { canonicalizePath } from '../../src/security/path-policy.js';

// 供「mkdirSync/writeFileSync 钩子模拟目录/文件被中途替换」类安全回归测试、以及比较
// 生产代码返回路径与测试字面构造路径是否指向同一位置使用:纯 path.resolve() 字面串
// 比较在 Windows 上会被 8.3 短名/长名(同一目录的两种有效别名,常见于 os.tmpdir() 在
// 不同调用路径上返回不一致的形式)骗过。用生产同款 canonicalizePath 消解——它对尚未
// 创建的路径也稳健(向上找最近已存在祖先规范化后拼回缺失段),而非退回字面串比较。
export function samePathReal(a: string, b: string): boolean {
  return canonicalizePath(a) === canonicalizePath(b);
}
