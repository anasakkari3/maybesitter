import { existsSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveIfExists(basePath) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.tsx'),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

export async function resolve(specifier, context, nextResolve) {
  const { parentURL } = context;

  if (specifier.startsWith('@/')) {
    const candidate = resolveIfExists(path.join(repoRoot, 'src', specifier.slice(2)));
    if (candidate) {
      return nextResolve(pathToFileURL(candidate).href, context);
    }
  }

  if (
    parentURL &&
    !specifier.startsWith('node:') &&
    !specifier.startsWith('http') &&
    (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/'))
  ) {
    const parentPath = fileURLToPath(parentURL);
    const dir = path.dirname(parentPath);
    const candidate = resolveIfExists(path.resolve(dir, specifier));
    if (candidate) {
      return nextResolve(pathToFileURL(candidate).href, context);
    }
  }

  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && (url.endsWith('.ts') || url.endsWith('.tsx'))) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        sourceMap: true,
      },
      fileName: fileURLToPath(url),
    });
    return {
      format: 'module',
      shortCircuit: true,
      source: transpiled.outputText,
    };
  }

  return nextLoad(url, context);
}
