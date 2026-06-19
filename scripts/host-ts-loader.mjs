// Node ESM 钩子:运行时在受限根内即时把 .ts 转译为 ESM(scripts · 工具库)
// ---------------------------------------------------------------------------
// 职责:实现 Node module 自定义加载器的 resolve/load 钩子。迁移期内源码仍写
//       NodeNext 风格的 .js 说明符,本钩子在解析失败时把已迁移的同名 .ts 兄弟文件
//       接上(仅限 apps/host/src·test、eval、scripts 这些受限根),并对 .ts 文件用
//       内存内 ts.transpileModule 转成 ES2022 源码返回,免去预编译。
// 用法:不直接运行;经 bootstrap-src/run-host-node.ts 通过 register() 挂载为 ESM 加载器。
// 依赖:typescript 编译器(优先仓库根,回退 ui 子项目的 node_modules)。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostSourceRoot = path.join(repoRoot, 'apps', 'host', 'src');
const hostTestRoot = path.join(repoRoot, 'apps', 'host', 'test');
const evalSourceRoot = path.join(repoRoot, 'eval');
const scriptsRoot = path.join(repoRoot, 'scripts');
const runtimeTypescriptRoots = [hostSourceRoot, hostTestRoot, evalSourceRoot, scriptsRoot];
const require = createRequire(import.meta.url);
function isInsideRuntimeTypescriptRoot(filePath) {
    return runtimeTypescriptRoots.some((root) => {
        const relative = path.relative(root, filePath);
        return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
}
// Migration rule: keep NodeNext-style `.js` specifiers in source, but when a
// runtime file has already moved to `.ts`, resolve only that jailed sibling.
function resolveSiblingTs(specifier, parentURL) {
    if (!specifier.endsWith('.js'))
        return null;
    if (specifier.startsWith('node:'))
        return null;
    let jsPath;
    if (specifier.startsWith('file:')) {
        jsPath = fileURLToPath(specifier);
    }
    else if (path.isAbsolute(specifier)) {
        jsPath = specifier;
    }
    else if (specifier.startsWith('./') || specifier.startsWith('../')) {
        if (!parentURL || !parentURL.startsWith('file:'))
            return null;
        jsPath = path.resolve(path.dirname(fileURLToPath(parentURL)), specifier);
    }
    else {
        return null;
    }
    const tsPath = `${jsPath.slice(0, -'.js'.length)}.ts`;
    return isInsideRuntimeTypescriptRoot(tsPath) && fs.existsSync(tsPath) ? tsPath : null;
}
function loadTypescript() {
    const candidates = [
        path.join(repoRoot, 'node_modules', 'typescript', 'lib', 'typescript.js'),
        path.join(repoRoot, 'apps', 'windows-client', 'ui', 'node_modules', 'typescript', 'lib', 'typescript.js'),
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) {
        throw new Error('[host-ts-loader] TypeScript compiler not found. Run npm install in apps/windows-client/ui first.');
    }
    return require(found);
}
const ts = loadTypescript();
export async function resolve(specifier, context, nextResolve) {
    try {
        return await nextResolve(specifier, context);
    }
    catch (error) {
        const tsPath = resolveSiblingTs(specifier, context.parentURL);
        if (tsPath) {
            return { url: pathToFileURL(tsPath).href, shortCircuit: true };
        }
        throw error;
    }
}
export async function load(url, context, nextLoad) {
    if (!url.startsWith('file:'))
        return nextLoad(url, context);
    const filePath = fileURLToPath(url);
    if (path.extname(filePath) !== '.ts' || !isInsideRuntimeTypescriptRoot(filePath)) {
        return nextLoad(url, context);
    }
    const source = await fs.promises.readFile(filePath, 'utf8');
    const output = ts.transpileModule(source, {
        fileName: filePath,
        compilerOptions: {
            module: ts.ModuleKind.ES2022,
            target: ts.ScriptTarget.ES2022,
            // Node coverage needs source maps here; otherwise stripped TypeScript
            // type lines shift execution counts onto the wrong .ts source lines.
            inlineSourceMap: true,
            inlineSources: true,
        },
        reportDiagnostics: true,
    });
    const errors = (output.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    if (errors.length) {
        throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
            getCanonicalFileName: (name) => name,
            getCurrentDirectory: () => repoRoot,
            getNewLine: () => '\n',
        }));
    }
    return { format: 'module', source: output.outputText, shortCircuit: true };
}
