const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertOwner,
  assertSessionIsEditable,
  assertWithdrawable,
  persistedLifecycleState,
  submitChangeType,
  transitionStatus,
} = require('../dist/services/formSessionLifecycle');
const { publicSession } = require('../dist/services/formSessionRecord');

function throwsWithStatus(status) {
  return (error) => {
    assert.equal(error.status, status);
    return true;
  };
}

function legacyRow(overrides = {}) {
  return {
    id: 'session-1',
    formId: 'form-1',
    formVersion: '1',
    mode: 'create',
    patientId: 'patient-1',
    patientNamespace: null,
    userId: 'user-1',
    authMode: 'local',
    status: 'draft',
    values: null,
    validation: null,
    runtimeContext: null,
    revision: 0,
    providerId: null,
    providerReference: null,
    draftReference: null,
    lifecycleState: null,
    lifecycleConfirmed: false,
    changeType: null,
    changeDescription: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

test('transitionStatus allows draft -> in_progress and rejects submitted -> in_progress with 409', () => {
  assert.equal(transitionStatus('draft', 'in_progress'), 'in_progress');
  assert.throws(() => transitionStatus('submitted', 'in_progress'), throwsWithStatus(409));
});

test('assertSessionIsEditable rejects submitted, cancelled and deleted sessions', () => {
  assert.throws(() => assertSessionIsEditable('submitted'), throwsWithStatus(409));
  assert.throws(() => assertSessionIsEditable('cancelled'), throwsWithStatus(409));
  assert.throws(() => assertSessionIsEditable('draft', 'deleted'), throwsWithStatus(409));
  assert.doesNotThrow(() => assertSessionIsEditable('draft', 'incomplete'));
});

test('assertOwner rejects another user with 403 but allows anonymous', () => {
  assert.throws(
    () => assertOwner({ userId: 'user-1' }, { userId: 'user-2', authMode: 'local' }),
    throwsWithStatus(403),
  );
  assert.doesNotThrow(() => assertOwner({ userId: 'user-1' }, { userId: 'user-1', authMode: 'local' }));
  assert.doesNotThrow(() => assertOwner({ userId: 'user-1' }, { userId: 'anonymous', authMode: 'local' }));
});

test('persistedLifecycleState maps legacy null/unknown values to new', () => {
  assert.equal(persistedLifecycleState(null), 'new');
  assert.equal(persistedLifecycleState(undefined), 'new');
  assert.equal(persistedLifecycleState('not-a-lifecycle-state'), 'new');
  assert.equal(persistedLifecycleState('complete'), 'complete');
});

test('assertWithdrawable rejects deleted, incomplete and reference-less sessions with 409', () => {
  assert.throws(
    () => assertWithdrawable({ lifecycleState: 'deleted', providerReference: 'composition-1' }),
    throwsWithStatus(409),
  );
  assert.throws(
    () => assertWithdrawable({ lifecycleState: 'incomplete', providerReference: 'composition-1' }),
    throwsWithStatus(409),
  );
  assert.throws(
    () => assertWithdrawable({ lifecycleState: 'complete', providerReference: null }),
    throwsWithStatus(409),
  );
  assert.doesNotThrow(() => assertWithdrawable({ lifecycleState: 'complete', providerReference: 'composition-1' }));
});

test('submitChangeType only yields a change type for a complete composition', () => {
  assert.equal(submitChangeType('incomplete', 'amendment', 'modification'), undefined);
  assert.equal(submitChangeType(null, 'amendment', 'modification'), undefined);
  assert.equal(submitChangeType('complete', undefined, undefined), 'modification');
  assert.equal(submitChangeType('complete', 'not-a-change-type', 'not-a-change-type'), 'modification');
  assert.equal(submitChangeType('complete', undefined, 'amendment'), 'amendment');
  assert.equal(submitChangeType('complete', 'amendment', undefined), 'amendment');
});

test('publicSession normalises a legacy row to lifecycleState new and empty values', () => {
  const session = publicSession(legacyRow());
  assert.equal(session.lifecycleState, 'new');
  assert.deepEqual(session.values, {});
  assert.equal('baseVersionUid' in session, false);
  assert.equal('changeType' in session, false);
});

test('publicSession exposes draftReference as baseVersionUid', () => {
  const session = publicSession(legacyRow({ draftReference: 'draft-1' }));
  assert.equal(session.baseVersionUid, 'draft-1');
  assert.equal(session.draftReference, 'draft-1');
});
