const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCapability, requireOpenEhrCapabilityConfig, CapabilityUnresolved, listAllCapabilities, OPENEHR_CAPABILITIES } = require('../dist/capability/catalog');
const { DynamicCapabilityRegistry } = require('../dist/capability/dynamicRegistry');

// User's own ask: "Form Builder as a capability" - resolving a capability
// should check a dynamic, MCP-tool-writable registry before falling back to
// the hand-authored static catalog, and a genuinely unknown name should
// throw a distinct, branchable error rather than a plain Error.

function freshRegistry() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csw-capreg-'));
  return new DynamicCapabilityRegistry(dataDir, '_clinic');
}

test('resolveCapability finds a known static entry with no dynamic registry given', () => {
  const config = resolveCapability('coded-diagnosis');
  assert.equal(config.role, 'basis');
  assert.equal(config.compositionFormId, OPENEHR_CAPABILITIES['coded-diagnosis'].compositionFormId);
});

test('resolveCapability returns undefined for an unknown name, never throws', () => {
  assert.equal(resolveCapability('does-not-exist'), undefined);
});

test('requireOpenEhrCapabilityConfig throws CapabilityUnresolved (not a plain Error) for an unknown name', () => {
  assert.throws(() => requireOpenEhrCapabilityConfig('does-not-exist'), (error) => {
    assert.ok(error instanceof CapabilityUnresolved);
    assert.equal(error.capability, 'does-not-exist');
    return true;
  });
});

test('a dynamically-registered capability resolves once registered, and is included in listAllCapabilities', () => {
  const dynamic = freshRegistry();
  assert.equal(resolveCapability('imaging-report-basis', dynamic), undefined);
  const config = dynamic.register('imaging-report-basis', {
    role: 'basis', description: 'Test-only capability',
    compositionFormId: 'comp-1', blockId: 'block-1', formSectionFormId: 'form-1', forceNewComposition: true,
  });
  assert.deepEqual(resolveCapability('imaging-report-basis', dynamic), config);
  const listed = listAllCapabilities(dynamic).find((entry) => entry.name === 'imaging-report-basis');
  assert.equal(listed.source, 'dynamic');
});

test('a dynamic entry shadows a static one of the same name, both in resolution and in listAllCapabilities', () => {
  const dynamic = freshRegistry();
  const override = { role: 'basis', compositionFormId: 'override-comp', blockId: 'block-1', formSectionFormId: 'override-form', forceNewComposition: true };
  dynamic.register('coded-diagnosis', override);
  assert.deepEqual(resolveCapability('coded-diagnosis', dynamic), override);
  const listed = listAllCapabilities(dynamic).filter((entry) => entry.name === 'coded-diagnosis');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].source, 'dynamic');
});
