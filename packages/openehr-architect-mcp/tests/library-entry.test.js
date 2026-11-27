import assert from 'node:assert/strict';
import test from 'node:test';

test('document-template entry exposes the compiler and resolver API', async () => {
  const entry = await import('openehr-architect-mcp/document-template');

  assert.equal(typeof entry.composeDocumentTemplate, 'function');
  assert.equal(typeof entry.deriveDocumentComponents, 'function');
  assert.equal(typeof entry.resolveComponents, 'function');
  assert.equal(typeof entry.ComponentResolutionError, 'function');
});

test('deep imports into the package dist are not exported', async () => {
  await assert.rejects(
    () => import('openehr-architect-mcp/dist/documentTemplate/index.js'),
    (error) => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  );
});

test('document-template entry resolves to the barrel, not the MCP server', () => {
  const resolved = import.meta.resolve('openehr-architect-mcp/document-template');

  assert.ok(resolved.endsWith('/dist/documentTemplate/index.js'), resolved);
});
