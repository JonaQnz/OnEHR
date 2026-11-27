// @vitest-environment node
// This test reads config files and the workspace packages only; it needs no
// DOM. The default jsdom environment breaks esbuild's TextEncoder invariant
// (esbuild is pulled in transitively by importing vite.config).
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { resolveAqlResultPath as fromAqlRuntimeEntry } from 'core/aql-runtime';
import { resolveAqlResultPath as fromBarrel } from 'core';
import viteConfig from '../vite.config';

/**
 * The workspace packages declare their public entry points in their own
 * package.json ("exports"). The web app resolves them through vite aliases
 * straight to source (see vite.config.ts) and mirrors the same entries in
 * tsconfig.app.json "paths" for the type checker. This test keeps the two
 * in sync: every tsconfig path must point at the same directory the vite
 * alias does, and only documented exceptions may exist on either side.
 */

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The node environment (needed above) has no localStorage, but the shared
// setup file's afterEach calls localStorage.clear() after every test.
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { clear() {} },
  });
}

/**
 * Vite matches a non-exact alias key as a prefix (`core` also covers
 * `core/aql-runtime`), so a tsconfig path counts as covered when it equals
 * an alias key or starts with one followed by a slash.
 */
function isCoveredByAlias(tsconfigPath: string, aliases: Record<string, string>) {
  return Object.keys(aliases).some(
    (aliasKey) => tsconfigPath === aliasKey || tsconfigPath.startsWith(`${aliasKey}/`),
  );
}

function readTsconfigPaths() {
  const tsconfigPath = path.join(webRoot, 'tsconfig.app.json');
  const { config, error } = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (error) {
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  }
  const options = config.compilerOptions;
  const baseUrl = path.resolve(path.dirname(tsconfigPath), options.baseUrl);
  return { baseUrl, paths: options.paths as Record<string, string[]> };
}

function readViteAliases() {
  const alias = viteConfig.resolve?.alias;
  if (!alias || Array.isArray(alias)) {
    throw new Error('vite.config.ts must declare resolve.alias as an object');
  }
  return alias as Record<string, string>;
}

describe('workspace package resolution', () => {
  it('resolves the worker entry and the barrel to the same module', () => {
    expect(fromAqlRuntimeEntry).toBe(fromBarrel);
  });

  it('maps every shared package to the same directory as the vite alias', () => {
    const { baseUrl, paths } = readTsconfigPaths();
    const aliases = readViteAliases();

    for (const key of ['core', 'core/aql-runtime', 'openehr-engine']) {
      const aliasTarget =
        key === 'core/aql-runtime' ? path.join(aliases.core!, 'aql-runtime') : aliases[key]!;

      expect(path.resolve(baseUrl, paths[key]![0]!)).toBe(aliasTarget);
    }
  });

  it('only documents the known exceptions between aliases and tsconfig paths', () => {
    const { paths } = readTsconfigPaths();
    const aliases = readViteAliases();

    expect(Object.keys(aliases).filter((key) => !(key in paths))).toEqual([
      'formbuilder-plugin-clinical-scores',
    ]);
    expect(Object.keys(paths).filter((key) => !isCoveredByAlias(key, aliases))).toEqual([
      'react-form-builder2',
    ]);
  });
});
