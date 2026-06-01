import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type tsModule from 'typescript';

type TsCompiler = typeof tsModule;
type ResolveContext = {
  parentURL?: string;
};
type ResolveResult = {
  url: string;
  shortCircuit?: boolean;
};
type LoadContext = Record<string, unknown>;
type LoadResult = {
  format?: string;
  source?: string;
  shortCircuit?: boolean;
};
type NextResolve = (specifier: string, context: ResolveContext) => Promise<ResolveResult>;
type NextLoad = (url: string, context: LoadContext) => Promise<LoadResult>;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostSourceRoot = path.join(repoRoot, 'apps', 'host', 'src');
const hostTestRoot = path.join(repoRoot, 'apps', 'host', 'test');
const evalSourceRoot = path.join(repoRoot, 'eval');
const scriptsRoot = path.join(repoRoot, 'scripts');
const runtimeTypescriptRoots = [hostSourceRoot, hostTestRoot, evalSourceRoot, scriptsRoot];
const require = createRequire(import.meta.url);

function isInsideRuntimeTypescriptRoot(filePath: string): boolean {
  return runtimeTypescriptRoots.some((root) => {
    const relative = path.relative(root, filePath);
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

// Migration rule: keep NodeNext-style `.js` specifiers in source, but when a
// runtime file has already moved to `.ts`, resolve only that jailed sibling.
function resolveSiblingTs(specifier: string, parentURL: string | undefined): string | null {
  if (!specifier.endsWith('.js')) return null;
  if (specifier.startsWith('node:')) return null;

  let jsPath: string;
  if (specifier.startsWith('file:')) {
    jsPath = fileURLToPath(specifier);
  } else if (path.isAbsolute(specifier)) {
    jsPath = specifier;
  } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    if (!parentURL || !parentURL.startsWith('file:')) return null;
    jsPath = path.resolve(path.dirname(fileURLToPath(parentURL)), specifier);
  } else {
    return null;
  }

  const tsPath = `${jsPath.slice(0, -'.js'.length)}.ts`;
  return isInsideRuntimeTypescriptRoot(tsPath) && fs.existsSync(tsPath) ? tsPath : null;
}

function loadTypescript(): TsCompiler {
  const candidates = [
    path.join(repoRoot, 'node_modules', 'typescript', 'lib', 'typescript.js'),
    path.join(repoRoot, 'apps', 'windows-client', 'ui', 'node_modules', 'typescript', 'lib', 'typescript.js'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error('[host-ts-loader] TypeScript compiler not found. Run npm install in apps/windows-client/ui first.');
  }
  return require(found) as TsCompiler;
}

const ts = loadTypescript();

export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<ResolveResult> {
  try {
    return await nextResolve(specifier, context);
  } catch (error: unknown) {
    const tsPath = resolveSiblingTs(specifier, context.parentURL);
    if (tsPath) {
      return { url: pathToFileURL(tsPath).href, shortCircuit: true };
    }
    throw error;
  }
}

export async function load(url: string, context: LoadContext, nextLoad: NextLoad): Promise<LoadResult> {
  if (!url.startsWith('file:')) return nextLoad(url, context);

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
      sourceMap: false,
      inlineSources: false,
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
