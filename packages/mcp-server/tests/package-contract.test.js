import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const bareDistImport = /from\s+['"][^.'"][^'"]*\/dist\//;

async function jsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await jsFiles(full)));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

test('no build output imports another package through its dist directory', async () => {
  const files = await jsFiles(distDir);
  assert.ok(files.length > 0, `no .js files under ${distDir}`);

  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (bareDistImport.test(source)) offenders.push(path.relative(distDir, file));
  }
  assert.deepEqual(offenders, []);
});

test('document template tools are registered by the server entry module', async () => {
  const { registerDocumentTemplateTools } = await import('../dist/tools/documentTemplateTools.js');

  assert.equal(typeof registerDocumentTemplateTools, 'function');
});
