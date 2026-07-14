import fs from 'node:fs';
import path from 'node:path';

// 供「mkdirSync/writeFileSync 钩子模拟目录/文件被中途替换」类安全回归测试使用:
// 判断某次调用的目标路径是否就是我们要拦截的那个路径。纯 path.resolve() 字面串比较
// 在 Windows 上会被 8.3 短名/长名(同一目录的两种有效别名,常见于 os.tmpdir() 在不同
// 调用路径上返回不一致的形式)骗过,导致钩子该触发时没触发,测试断言不到预期异常。
// 用 fs.realpathSync.native 消解后再比较;目标尚不存在时(创建前拦截的场景)退回字面串比较。
export function samePathReal(a: string, b: string): boolean {
  try {
    const realA = fs.realpathSync.native ? fs.realpathSync.native(a) : fs.realpathSync(a);
    const realB = fs.realpathSync.native ? fs.realpathSync.native(b) : fs.realpathSync(b);
    return realA === realB;
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}
