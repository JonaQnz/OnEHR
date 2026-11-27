const assert = require('node:assert/strict');
const test = require('node:test');

// Resumable atomic commits (postContribution / readBackContribution split):
// once the CDR confirmed the POST, its Contribution UID is the durable
// checkpoint - a failed readback or failed local reconciliation must be
// finishable through the same commit endpoint without a second POST, and an
// unclear POST outcome must never invite a replay.
const prisma = require('../dist/db/prisma').default;
const compositionSessions = require('../dist/services/compositionSessionService');
const compositionRepo = require('../dist/services/compositionRepository');
const formSessions = require('../dist/services/formSessionService');
const ehrbaseService = require('../dist/services/ehrbaseService');
const configService = require('../dist/services/configService');
const clinicalTransactions = require('../dist/services/clinicalTransactionService');
const canonicalCompositionModule = require(require.resolve('openehr-engine').replace(/index\.js$/, 'canonicalComposition.js'));

const actor = { userId: 'clinician-1', authMode: 'local' };

const original = {
  transaction: prisma.$transaction,
  formFindUnique: prisma.form.findUnique,
  formSessionFindMany: prisma.formSession.findMany,
  clinicalTransactionFindUnique: prisma.clinicalTransaction.findUnique,
  clinicalTransactionUpdateMany: prisma.clinicalTransaction.updateMany,
  clinicalTransactionUpdate: prisma.clinicalTransaction.update,
  clinicalTransactionOperationFindMany: prisma.clinicalTransactionOperation.findMany,
  clinicalTransactionOperationFindFirst: prisma.clinicalTransactionOperation.findFirst,
  clinicalTransactionDelete: prisma.clinicalTransaction.delete,
  formSessionUpdate: prisma.formSession.update,
  compositionVersionEventUpsert: prisma.compositionVersionEvent.upsert,
  clinicalTransactionOperationUpdate: prisma.clinicalTransactionOperation.update,
  clinicalTransactionOperationUpdateMany: prisma.clinicalTransactionOperation.updateMany,
  getCompositionSession: compositionSessions.getCompositionSession,
  getCompositionRepository: compositionRepo.getCompositionRepository,
  applySuccessfulProviderCommit: formSessions.applySuccessfulProviderCommit,
  getRemoteWebTemplate: ehrbaseService.getRemoteWebTemplate,
  buildCanonicalComposition: canonicalCompositionModule.buildCanonicalComposition,
  getConfig: configService.getConfig,
};

function childForm(id) {
  return { id, version: '1.0.0', canonical_json: { id, name: id, version: '1.0.0', sourceTemplates: [{ id: 'tpl.v1', alias: 'tpl', type: 'openEhrWebTemplate' }], layout: { type: 'form', children: [] }, bindings: {}, locales: {} } };
}

function compositionForm(requireAtomicCommit) {
  return {
    id: 'composition-form',
    canonical_json: {
      extensions: {
        'watehr.composition': {
          schemaVersion: '1.0',
          pages: [{ id: 'p', title: 'p', blocks: [], layout: [] }],
          ...(requireAtomicCommit !== undefined ? { requireAtomicCommit } : {}),
        },
      },
    },
  };
}

/**
 * @param startStatus 'ready' (fresh) or 'committing' with a checkpointed contribution
 * @param readbackFailures number of readback calls that fail before one succeeds
 * @param missingVersionFor blockId whose readback version is withheld ('block-b')
 * @param postError error thrown by postContribution instead of a UID
 * @param fallbackResults per-formId: 'ok' | 'fail' | 'unknown' (non-atomic fallback)
 */
function installStore({
  startStatus = 'ready',
  contributionUid = null,
  readbackFailures = 0,
  reconcileFailures = 0,
  missingVersionFor = null,
  postError = null,
  atomic = true,
  requireAtomicCommit,
  fallbackResults = {},
  useRealApply = false,
  versionEventFailures = 0,
} = {}) {
  const forms = new Map([['composition-form', compositionForm(requireAtomicCommit)], ['form-a', childForm('form-a')], ['form-b', childForm('form-b')]]);
  const now = () => new Date('2026-11-27T10:00:00.000Z');
  let transaction = {
    id: 'txn-1', compositionSessionId: 'session-1', ehrId: 'ehr-1', userId: actor.userId, authMode: actor.authMode,
    status: startStatus, description: 'Test transaction', contributionUid, atomic: null, errorCode: null, errorMessage: null,
    revision: startStatus === 'ready' ? 0 : 1, createdAt: now(), updatedAt: now(),
  };
  let operations = [
    { id: 'op-a', transactionId: 'txn-1', formSessionId: 'session-a', blockId: 'block-a', type: 'create', baseVersionUid: null, resultVersionUid: null, status: 'ready', changeDescription: null, errorCode: null, errorMessage: null, createdAt: now(), updatedAt: now() },
    { id: 'op-b', transactionId: 'txn-1', formSessionId: 'session-b', blockId: 'block-b', type: 'create', baseVersionUid: null, resultVersionUid: null, status: 'ready', changeDescription: null, errorCode: null, errorMessage: null, createdAt: now(), updatedAt: now() },
  ];
  const sessionRows = new Map([
    ['session-a', { id: 'session-a', formId: 'form-a', values: { field: 'a' }, draftReference: null, providerReference: null }],
    ['session-b', { id: 'session-b', formId: 'form-b', values: { field: 'b' }, draftReference: null, providerReference: null }],
  ]);
  const counts = { posts: 0, readbacks: 0, applies: 0, fallbackCommits: {}, builds: 0, versionEvents: 0 };
  let readbacksLeftToFail = readbackFailures;
  let reconcileFailuresLeft = reconcileFailures;
  let versionEventsLeftToFail = versionEventFailures;
  let loadGateResolve;
  let loadGate = Promise.resolve();
  let loadGateArmed = false;

  const applyData = (data) => {
    const next = { ...transaction, ...data, updatedAt: now() };
    next.revision = data.revision?.increment ? transaction.revision + data.revision.increment : transaction.revision;
    return next;
  };

  prisma.$transaction = async (arg) => (Array.isArray(arg) ? Promise.all(arg) : arg(prisma));
  prisma.form.findUnique = async ({ where }) => forms.get(where.id) || null;
  prisma.formSession.findMany = async ({ where }) => where.id.in.map((id) => sessionRows.get(id)).filter(Boolean);
  prisma.clinicalTransaction.findUnique = async () => ({ ...transaction });
  prisma.clinicalTransaction.updateMany = async ({ where, data }) => {
    if (where.id !== undefined && transaction.id !== where.id) return { count: 0 };
    if (where.status !== undefined && transaction.status !== where.status) return { count: 0 };
    if (where.revision !== undefined && transaction.revision !== where.revision) return { count: 0 };
    if (where.contributionUid !== undefined && transaction.contributionUid !== where.contributionUid) return { count: 0 };
    transaction = applyData(data);
    return { count: 1 };
  };
  prisma.clinicalTransaction.update = async ({ data }) => {
    transaction = applyData(data);
    return { ...transaction };
  };
  prisma.clinicalTransactionOperation.findMany = async () => {
    if (loadGateArmed) await loadGate;
    return operations.map((op) => ({ ...op }));
  };
  prisma.clinicalTransactionOperation.update = async ({ where, data }) => {
    operations = operations.map((op) => (op.id === where.id ? { ...op, ...data, updatedAt: now() } : op));
    return operations.find((op) => op.id === where.id);
  };
  prisma.clinicalTransactionOperation.updateMany = async ({ where, data }) => {
    operations = operations.map((op) => (op.transactionId === where.transactionId && where.status.in.includes(op.status) ? { ...op, ...data } : op));
    return { count: operations.length };
  };
  compositionSessions.getCompositionSession = async () => ({ id: 'session-1', compositionFormId: 'composition-form', patientId: 'patient-1', patientNamespace: 'default' });
  ehrbaseService.getRemoteWebTemplate = async () => ({ tree: {} });
  canonicalCompositionModule.buildCanonicalComposition = () => { counts.builds += 1; return { _type: 'COMPOSITION', name: { value: 'Test' } }; };
  compositionRepo.getCompositionRepository = () => atomic ? {
    supportsContribution: true,
    postContribution: async () => {
      counts.posts += 1;
      if (postError) throw postError;
      return { contributionUid: 'contribution-1', ehrId: 'ehr-1' };
    },
    readBackContribution: async (input, uid) => {
      counts.readbacks += 1;
      if (readbacksLeftToFail > 0) {
        readbacksLeftToFail -= 1;
        throw new Error('simulated GET failure for the accepted Contribution');
      }
      return {
        contributionUid: uid,
        versions: input.operations
          .filter((op) => (missingVersionFor ? operations[op.operationIndex].blockId !== missingVersionFor : true))
          .map((op) => ({ operationIndex: op.operationIndex, versionUid: `result-${op.operationIndex}::sys::1` })),
      };
    },
  } : {
    supportsContribution: false,
    commit: async (input) => {
      const formId = input.form.id;
      counts.fallbackCommits[formId] = (counts.fallbackCommits[formId] || 0) + 1;
      if (fallbackResults[formId] === 'fail') throw new Error(`simulated failure for ${formId}`);
      if (fallbackResults[formId] === 'unknown') {
        const error = new Error('The Contribution commit outcome is unknown');
        error.code = 'CONTRIBUTION_OUTCOME_UNKNOWN';
        throw error;
      }
      return { providerId: 'ehrbase', reference: `${formId}-version-1`, metadata: { ehrId: 'ehr-1' }, lifecycleState: 'complete', lifecycleConfirmed: true };
    },
  };
  formSessions.applySuccessfulProviderCommit = async (sessionId) => {
    counts.applies += 1;
    if (reconcileFailuresLeft > 0) {
      reconcileFailuresLeft -= 1;
      throw new Error('simulated local DB failure while reconciling');
    }
    return {};
  };
  if (useRealApply) {
    // Exercise the real applySuccessfulProviderCommit, including its strict
    // version-event write, against these stores.
    formSessions.applySuccessfulProviderCommit = original.applySuccessfulProviderCommit;
    prisma.formSession.update = async ({ where, data }) => ({ id: where.id, ...data, revision: 1 });
    prisma.compositionVersionEvent.upsert = async ({ where, create }) => {
      counts.versionEvents += 1;
      if (versionEventsLeftToFail > 0) {
        versionEventsLeftToFail -= 1;
        throw new Error('simulated version-event DB failure');
      }
      return { id: `event-${where.versionUid}`, ...create };
    };
  }
  configService.getConfig = () => ({ requireAtomicCommitByDefault: true });

  return {
    counts,
    getOperations: () => operations.map((op) => ({ ...op })),
    getTransaction: () => ({ ...transaction }),
    // Both callers load the transaction before either can claim it - the
    // closest unit-level approximation of two requests arriving together.
    armLoadGate: () => {
      loadGate = new Promise((resolve) => { loadGateResolve = resolve; });
      loadGateArmed = true;
    },
    openLoadGate: () => { loadGateArmed = false; loadGateResolve(); },
    setMissingVersionFor: (blockId) => { missingVersionFor = blockId; },
    restore: () => {
      prisma.$transaction = original.transaction;
      prisma.form.findUnique = original.formFindUnique;
      prisma.formSession.findMany = original.formSessionFindMany;
      prisma.clinicalTransaction.findUnique = original.clinicalTransactionFindUnique;
      prisma.clinicalTransaction.updateMany = original.clinicalTransactionUpdateMany;
      prisma.clinicalTransaction.update = original.clinicalTransactionUpdate;
      prisma.clinicalTransactionOperation.findMany = original.clinicalTransactionOperationFindMany;
      prisma.clinicalTransactionOperation.update = original.clinicalTransactionOperationUpdate;
      prisma.clinicalTransactionOperation.updateMany = original.clinicalTransactionOperationUpdateMany;
      compositionSessions.getCompositionSession = original.getCompositionSession;
      compositionRepo.getCompositionRepository = original.getCompositionRepository;
      formSessions.applySuccessfulProviderCommit = original.applySuccessfulProviderCommit;
      prisma.formSession.update = original.formSessionUpdate;
      prisma.compositionVersionEvent.upsert = original.compositionVersionEventUpsert;
      ehrbaseService.getRemoteWebTemplate = original.getRemoteWebTemplate;
      canonicalCompositionModule.buildCanonicalComposition = original.buildCanonicalComposition;
      configService.getConfig = original.getConfig;
    },
  };
}

test('a confirmed POST is checkpointed: a failed readback is resumed through the same endpoint without a second POST or rebuild', async () => {
  const store = installStore({ readbackFailures: 1 });
  try {
    await assert.rejects(
      clinicalTransactions.commitClinicalTransaction('txn-1', actor),
      (error) => { assert.equal(error.details?.code, 'CLINICAL_TRANSACTION_READBACK_PENDING'); return true; },
    );
    assert.equal(store.counts.posts, 1, 'exactly one POST');
    assert.equal(store.counts.readbacks, 1);
    assert.equal(store.getTransaction().status, 'committing', 'known CDR state must not be marked failed');
    assert.equal(store.getTransaction().contributionUid, 'contribution-1', 'the accepted UID is the durable checkpoint');
    assert.equal(store.counts.builds, 2, 'built once per operation for the POST');

    // Restart/resume: fresh call, same endpoint, persisted state only.
    const result = await clinicalTransactions.commitClinicalTransaction('txn-1', actor);
    assert.equal(result.status, 'committed');
    assert.equal(result.contributionUid, 'contribution-1');
    assert.equal(store.counts.posts, 1, 'the resumed commit must not POST again');
    assert.equal(store.counts.readbacks, 2);
    assert.equal(store.counts.builds, 2, 'a resume never rebuilds/needs the CDR template tree');
    assert.deepEqual(store.getOperations().map((op) => op.status), ['committed', 'committed']);
  } finally { store.restore(); }
});

test('a failed local reconciliation after the POST is resumed without a second POST', async () => {
  const store = installStore({ reconcileFailures: 1 });
  try {
    await assert.rejects(
      clinicalTransactions.commitClinicalTransaction('txn-1', actor),
      (error) => { assert.equal(error.details?.code, 'CLINICAL_TRANSACTION_RECONCILE_PENDING'); return true; },
    );
    assert.equal(store.counts.posts, 1);
    assert.equal(store.getTransaction().status, 'committing');
    assert.equal(store.getTransaction().contributionUid, 'contribution-1');

    const result = await clinicalTransactions.commitClinicalTransaction('txn-1', actor);
    assert.equal(result.status, 'committed');
    assert.equal(store.counts.posts, 1, 'no replay POST after a local DB failure');
    assert.deepEqual(store.getOperations().map((op) => op.status), ['committed', 'committed']);
  } finally { store.restore(); }
});

test('two parallel resumptions of the same accepted Contribution: one wins the claim, the other is refused', async () => {
  const store = installStore({ startStatus: 'committing', contributionUid: 'contribution-1' });
  try {
    store.armLoadGate();
    const first = clinicalTransactions.commitClinicalTransaction('txn-1', actor);
    const second = clinicalTransactions.commitClinicalTransaction('txn-1', actor);
    await new Promise((resolve) => setImmediate(resolve));
    store.openLoadGate();

    const settled = await Promise.allSettled([first, second]);
    const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
    const rejected = settled.filter((entry) => entry.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one resumption may proceed');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.details?.code, 'CLINICAL_TRANSACTION_COMMIT_IN_PROGRESS');
    assert.equal(fulfilled[0].value.status, 'committed');
    assert.equal(store.counts.posts, 0, 'a resumption never POSTs again');
    assert.equal(store.counts.readbacks, 1, 'only the winning claim reads back');
  } finally { store.restore(); }
});

test('a Contribution read back without a version for every operation is never reported as full success', async () => {
  const store = installStore({ missingVersionFor: 'block-b' });
  try {
    await assert.rejects(
      clinicalTransactions.commitClinicalTransaction('txn-1', actor),
      (error) => { assert.equal(error.details?.code, 'CLINICAL_TRANSACTION_INCOMPLETE'); return true; },
    );
    assert.notEqual(store.getTransaction().status, 'committed');
    assert.equal(store.getTransaction().status, 'committing');
    assert.equal(store.getTransaction().contributionUid, 'contribution-1');
    const opB = store.getOperations().find((op) => op.id === 'op-b');
    assert.equal(opB.resultVersionUid, null);
    assert.equal(opB.status, 'pending');
    assert.equal(store.counts.posts, 1);

    // Once the CDR confirms the missing version, the same transaction is
    // completed from the checkpoint alone.
    store.setMissingVersionFor(null);
    const result = await clinicalTransactions.commitClinicalTransaction('txn-1', actor);
    assert.equal(result.status, 'committed');
    assert.equal(store.counts.posts, 1, 'no second POST to obtain the missing version');
    assert.deepEqual(store.getOperations().map((op) => op.status), ['committed', 'committed']);
  } finally { store.restore(); }
});

test('an unclear POST outcome is blocked from replay and reported as a clarification state, not failed', async () => {
  const error = new Error('The Contribution commit outcome is unknown (502): the CDR may have committed it.');
  error.code = 'CONTRIBUTION_OUTCOME_UNKNOWN';
  const store = installStore({ postError: error });
  try {
    await assert.rejects(
      clinicalTransactions.commitClinicalTransaction('txn-1', actor),
      (thrown) => { assert.equal(thrown.details?.code, 'CONTRIBUTION_OUTCOME_UNKNOWN'); return true; },
    );
    assert.equal(store.getTransaction().status, 'committing');
    assert.notEqual(store.getTransaction().status, 'failed');
    assert.equal(store.getTransaction().contributionUid, null);
    assert.equal(store.getTransaction().errorCode, 'CONTRIBUTION_OUTCOME_UNKNOWN');
    assert.equal(store.counts.posts, 1);

    await assert.rejects(
      clinicalTransactions.commitClinicalTransaction('txn-1', actor),
      (thrown) => {
        assert.equal(thrown.details?.code, 'CONTRIBUTION_OUTCOME_UNKNOWN');
        assert.match(thrown.message, /outcome is unknown/);
        return true;
      },
    );
    assert.equal(store.counts.posts, 1, 'an unclear POST is never replayed');
    assert.equal(store.counts.readbacks, 0);
  } finally { store.restore(); }
});

test('the sequential fallback preserves confirmed writes and never replays an unclear operation', async () => {
  const store = installStore({ atomic: false, requireAtomicCommit: false, fallbackResults: { 'form-a': 'ok', 'form-b': 'unknown' } });
  try {
    const result = await clinicalTransactions.commitClinicalTransaction('txn-1', actor);
    assert.equal(result.status, 'partial');
    assert.equal(result.atomic, false);
    const [opA, opB] = store.getOperations();
    assert.equal(opA.status, 'committed');
    assert.equal(opA.resultVersionUid, 'form-a-version-1', 'an already confirmed write is preserved');
    assert.equal(opB.status, 'pending');
    assert.equal(opB.errorCode, 'CONTRIBUTION_OUTCOME_UNKNOWN');
    assert.deepEqual(store.counts.fallbackCommits, { 'form-a': 1, 'form-b': 1 });

    await assert.rejects(
      clinicalTransactions.commitClinicalTransaction('txn-1', actor),
      (thrown) => { assert.equal(thrown.details?.code, 'CLINICAL_TRANSACTION_NOT_READY'); return true; },
    );
    assert.deepEqual(store.counts.fallbackCommits, { 'form-a': 1, 'form-b': 1 }, 'no automatic replay of the unclear operation');
  } finally { store.restore(); }
});

test('prepare does not delete/re-prepare a transaction whose outcome is unclear (no automatic replay)', async () => {
  const now = new Date('2026-11-27T10:00:00.000Z');
  const existing = {
    id: 'txn-partial', compositionSessionId: 'session-1', ehrId: 'ehr-1', userId: actor.userId, authMode: actor.authMode,
    status: 'partial', description: null, contributionUid: null, atomic: false, clientRequestId: 'req-1',
    errorCode: 'CONTRIBUTION_OUTCOME_UNKNOWN', errorMessage: 'The Contribution commit outcome is unknown',
    revision: 3, createdAt: now, updatedAt: now,
  };
  const operation = {
    id: 'op-b', transactionId: 'txn-partial', formSessionId: 'session-b', blockId: 'block-b', type: 'create',
    baseVersionUid: null, resultVersionUid: null, status: 'pending', changeDescription: null,
    errorCode: 'CONTRIBUTION_OUTCOME_UNKNOWN', errorMessage: 'The Contribution commit outcome is unknown', createdAt: now,
  };
  prisma.clinicalTransaction.findUnique = async () => ({ ...existing });
  prisma.clinicalTransactionOperation.findFirst = async () => ({ ...operation });
  prisma.clinicalTransactionOperation.findMany = async () => [{ ...operation }];
  prisma.clinicalTransaction.delete = async () => { throw new Error('prepare must not delete an unclear transaction'); };
  try {
    const result = await clinicalTransactions.prepareClinicalTransaction('session-1', actor, { clientRequestId: 'req-1' });
    assert.equal(result.status, 'partial');
    assert.equal(result.errorCode, 'CONTRIBUTION_OUTCOME_UNKNOWN');
    assert.equal(result.operations.length, 1);
  } finally {
    prisma.clinicalTransaction.findUnique = original.clinicalTransactionFindUnique;
    prisma.clinicalTransactionOperation.findFirst = original.clinicalTransactionOperationFindFirst;
    prisma.clinicalTransactionOperation.findMany = original.clinicalTransactionOperationFindMany;
    prisma.clinicalTransaction.delete = original.clinicalTransactionDelete;
  }
});

test('reconciliation confirms the session update, the operation result and the version event together', async () => {
  const store = installStore({ useRealApply: true });
  try {
    const result = await clinicalTransactions.commitClinicalTransaction('txn-1', actor);
    assert.equal(result.status, 'committed');
    assert.equal(store.counts.versionEvents, 2, 'one version event per confirmed operation');
    assert.equal(store.counts.posts, 1);
    assert.deepEqual(store.getOperations().map((op) => op.resultVersionUid), ['result-0::sys::1', 'result-1::sys::1']);
  } finally { store.restore(); }
});

test('a version event that cannot be recorded keeps the transaction resumable instead of reporting success', async () => {
  const store = installStore({ useRealApply: true, versionEventFailures: 1 });
  try {
    await assert.rejects(
      clinicalTransactions.commitClinicalTransaction('txn-1', actor),
      (error) => { assert.equal(error.details?.code, 'CLINICAL_TRANSACTION_RECONCILE_PENDING'); return true; },
    );
    assert.equal(store.getTransaction().status, 'committing');
    assert.notEqual(store.getTransaction().status, 'committed');
    assert.equal(store.counts.posts, 1);

    const result = await clinicalTransactions.commitClinicalTransaction('txn-1', actor);
    assert.equal(result.status, 'committed');
    assert.equal(store.counts.posts, 1);
    assert.equal(store.counts.versionEvents, 3, 'the failed event is retried, the confirmed ones are upserts');
  } finally { store.restore(); }
});
