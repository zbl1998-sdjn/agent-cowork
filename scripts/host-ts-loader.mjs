import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostSourceRoot = path.join(repoRoot, 'apps', 'host', 'src');
const require = createRequire(import.meta.url);

function isInsideHostSource(filePath) {
  const relative = path.relative(hostSourceRoot, filePath);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// Migration rule: keep NodeNext-style `.js` specifiers in source, but when a
// host file has already moved to `.ts`, resolve only that jailed sibling.
function resolveSiblingTs(specifier, parentURL) {
  if (!specifier.endsWith('.js')) return null;
  if (specifier.startsWith('node:')) return null;

  let jsPath;
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
  return isInsideHostSource(tsPath) && fs.existsSync(tsPath) ? tsPath : null;
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
  } catch (error) {
    const tsPath = resolveSiblingTs(specifier, context.parentURL);
    if (tsPath) {
      return { url: pathToFileURL(tsPath).href, shortCircuit: true };
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:')) return nextLoad(url, context);

  const filePath = fileURLToPath(url);
  if (path.extname(filePath) !== '.ts' || !isInsideHostSource(filePath)) {
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
