const assert = require('node:assert/strict');
const test = require('node:test');
const { enrichVersionWithLocalEvent } = require('../dist/services/compositionHistoryService');

function cdrVersion(overrides) {
  return {
    compositionUid: 'comp-1',
    versionUid: 'comp-1::system::2',
    versionNumber: 2,
    lifecycleState: 'complete', // this CDR always reports complete (confirmed live)
    lifecycleConfirmed: false,
    changeType: 'modification',
    changeTypeConfirmed: true,
    committedAt: '2026-08-25T18:50:12.000Z',
    committer: { name: 'EHRbase Internal technical-account' },
    ...overrides,
  };
}

// Test 1 (partial) - a version with no matching local event is left exactly
// as the CDR reported it - never silently "corrected".
test('a version with no local CompositionVersionEvent is returned unchanged', () => {
  const version = cdrVersion();
  const enriched = enrichVersionWithLocalEvent(version, undefined);
  assert.deepEqual(enriched, version);
});

// Test 1/3 - the CDR's own lifecycle_state (always "complete" on this
// deployment, confirmed live) is overridden by Forms' own record when one
// exists for this exact version, and the override is marked confirmed.
test('a matching local event upgrades lifecycleState/changeType and marks them confirmed', () => {
  const version = cdrVersion({ lifecycleState: 'complete', lifecycleConfirmed: false });
  const enriched = enrichVersionWithLocalEvent(version, {
    lifecycleState: 'incomplete',
    changeType: 'amendment',
    changeDescription: 'Falsches Körpergewicht korrigiert',
  });
  assert.equal(enriched.lifecycleState, 'incomplete');
  assert.equal(enriched.lifecycleConfirmed, true);
  assert.equal(enriched.changeType, 'amendment');
  assert.equal(enriched.changeTypeConfirmed, true);
  assert.equal(enriched.changeDescription, 'Falsches Körpergewicht korrigiert');
});

test('an invalid/unrecognized local changeType never overrides the CDR-confirmed one', () => {
  const version = cdrVersion({ changeType: 'modification' });
  const enriched = enrichVersionWithLocalEvent(version, { lifecycleState: 'incomplete', changeType: 'not-a-real-change-type' });
  assert.equal(enriched.changeType, 'modification');
});

// Test 2 - Committer and Composer stay distinct, untouched by enrichment
// (enrichment only ever adjusts lifecycleState/changeType/changeDescription).
test('composer and committer are preserved separately through enrichment', () => {
  const version = cdrVersion({
    committer: { name: 'M. Meyer' },
    composer: { name: 'Dr. Schmidt' },
  });
  const enriched = enrichVersionWithLocalEvent(version, { lifecycleState: 'complete', changeType: 'modification' });
  assert.equal(enriched.committer.name, 'M. Meyer');
  assert.equal(enriched.composer.name, 'Dr. Schmidt');
  assert.notEqual(enriched.committer.name, enriched.composer.name);
});
