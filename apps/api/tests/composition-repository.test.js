const assert = require('node:assert/strict');
const test = require('node:test');
const { getCompositionRepository } = require('../dist/services/compositionRepository');

test('exposes a CompositionRepository only for providers with a real openEHR versioning mechanism', () => {
  assert.equal(getCompositionRepository('n8n'), undefined, 'a provider with no lifecycle/versioning mechanism must signal that explicitly, not silently no-op');
  assert.equal(getCompositionRepository(undefined), undefined);

  const repo = getCompositionRepository('ehrbase');
  assert.ok(repo);
  assert.equal(typeof repo.commit, 'function');
  assert.equal(typeof repo.withdraw, 'function');
  // Epic 3
  assert.equal(typeof repo.getVersionHistory, 'function');
  assert.equal(typeof repo.getVersionContent, 'function');
});

test('returns the same cached repository instance for repeated lookups', () => {
  const first = getCompositionRepository('ehrbase');
  const second = getCompositionRepository('ehrbase');
  assert.equal(first, second);
});
