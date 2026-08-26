const assert = require('node:assert/strict');
const test = require('node:test');

// Per-Composition requireAtomicCommit + the global requireAtomicCommitByDefault
// (Configurable Settings roadmap, P1): commitClinicalTransaction's non-atomic
// sequential fallback, only reachable when the active provider doesn't
// support Contribution AND the Composition/global default allows falling
// back - not reachable live against this deployment's real EHRbase (which
// always supports Contribution), so this is the only way to exercise it.
const prisma = require('../dist/db/prisma').default;
const compositionSessions = require('../dist/services/compositionSessionService');
const compositionRepo = require('../dist/services/compositionRepository');
const formSessions = require('../dist/services/formSessionService');
const configService = require('../dist/services/configService');
const clinicalTransactions = require('../dist/services/clinicalTransactionService');

const actor = { userId: 'clinician-1', authMode: 'local' };

const original = {
  transaction: prisma.$transaction,
  formFindUnique: prisma.form.findUnique,
  formSessionFindMany: prisma.formSession.findMany,
  clinicalTransactionFindUnique: prisma.clinicalTransaction.findUnique,
  clinicalTransactionUpdateMany: prisma.clinicalTransaction.updateMany,
  clinicalTransactionUpdate: prisma.clinicalTransaction.update,
  clinicalTransactionOperationFindMany: prisma.clinicalTransactionOperation.findMany,
  clinicalTransactionOperationUpdate: prisma.clinicalTransactionOperation.update,
  clinicalTransactionOperationUpdateMany: prisma.clinicalTransactionOperation.updateMany,
  getCompositionSession: compositionSessions.getCompositionSession,
  getCompositionRepository: compositionRepo.getCompositionRepository,
  applySuccessfulProviderCommit: formSessions.applySuccessfulProviderCommit,
  getConfig: configService.getConfig,
};

function childForm(id) {
  return { id, version: '1.0.0', canonical_json: { id, name: id, version: '1.0.0', sourceTemplates: [], layout: { type: 'form', children: [] }, bindings: {}, locales: {} } };
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
 * @param results per-childFormId: 'ok' commits successfully, 'fail' throws.
 */
function installStore({ requireAtomicCommit, requireAtomicCommitByDefault, results = {} } = {}) {
  const forms = new Map([['composition-form', compositionForm(requireAtomicCommit)], ['form-a', childForm('form-a')], ['form-b', childForm('form-b')]]);
  const now = () => new Date('2026-08-27T10:00:00.000Z');
  let transaction = {
    id: 'txn-1', compositionSessionId: 'session-1', ehrId: 'ehr-1', userId: actor.userId, authMode: actor.authMode,
    status: 'ready', description: 'Test transaction', contributionUid: null, atomic: null, errorCode: null, errorMessage: null,
    revision: 0, createdAt: now(), updatedAt: now(),
  };
  let operations = [
    { id: 'op-a', transactionId: 'txn-1', formSessionId: 'session-a', blockId: 'block-a', type: 'create', baseVersionUid: null, resultVersionUid: null, status: 'ready', changeDescription: null, errorCode: null, errorMessage: null, createdAt: now(), updatedAt: now() },
    { id: 'op-b', transactionId: 'txn-1', formSessionId: 'session-b', blockId: 'block-b', type: 'create', baseVersionUid: null, resultVersionUid: null, status: 'ready', changeDescription: null, errorCode: null, errorMessage: null, createdAt: now(), updatedAt: now() },
  ];
  const sessionRows = new Map([
    ['session-a', { id: 'session-a', formId: 'form-a', values: { field: 'a' }, draftReference: null, providerReference: null }],
    ['session-b', { id: 'session-b', formId: 'form-b', values: { field: 'b' }, draftReference: null, providerReference: null }],
  ]);
  const committedSessions = [];

  prisma.$transaction = async (arg) => (Array.isArray(arg) ? Promise.all(arg) : arg(prisma));
  prisma.form.findUnique = async ({ where }) => forms.get(where.id) || null;
  prisma.formSession.findMany = async ({ where }) => where.id.in.map((id) => sessionRows.get(id)).filter(Boolean);
  prisma.clinicalTransaction.findUnique = async () => ({ ...transaction });
  prisma.clinicalTransaction.updateMany = async ({ where, data }) => {
    if (transaction.status !== where.status) return { count: 0 };
    transaction = { ...transaction, ...data, revision: data.revision?.increment ? transaction.revision + data.revision.increment : transaction.revision, updatedAt: now() };
    return { count: 1 };
  };
  prisma.clinicalTransaction.update = async ({ data }) => {
    transaction = { ...transaction, ...data, revision: data.revision?.increment ? transaction.revision + data.revision.increment : transaction.revision, updatedAt: now() };
    return { ...transaction };
  };
  prisma.clinicalTransactionOperation.findMany = async () => operations.map((op) => ({ ...op }));
  prisma.clinicalTransactionOperation.update = async ({ where, data }) => {
    operations = operations.map((op) => (op.id === where.id ? { ...op, ...data, updatedAt: now() } : op));
    return operations.find((op) => op.id === where.id);
  };
  prisma.clinicalTransactionOperation.updateMany = async ({ where, data }) => {
    operations = operations.map((op) => (op.transactionId === where.transactionId && where.status.in.includes(op.status) ? { ...op, ...data } : op));
    return { count: operations.length };
  };
  compositionSessions.getCompositionSession = async () => ({ id: 'session-1', compositionFormId: 'composition-form', patientId: 'patient-1', patientNamespace: 'default' });
  compositionRepo.getCompositionRepository = () => ({
    supportsContribution: false,
    commit: async (input) => {
      const formId = input.form.id;
      if (results[formId] === 'fail') throw new Error(`simulated failure for ${formId}`);
      return { providerId: 'ehrbase', reference: `${formId}-version-1`, metadata: { ehrId: 'ehr-1' }, lifecycleState: 'complete', lifecycleConfirmed: true };
    },
  });
  formSessions.applySuccessfulProviderCommit = async (sessionId) => { committedSessions.push(sessionId); return {}; };
  configService.getConfig = () => ({ requireAtomicCommitByDefault: requireAtomicCommitByDefault ?? true });

  return {
    committedSessions,
    getOperations: () => operations,
    getTransaction: () => transaction,
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
      configService.getConfig = original.getConfig;
    },
  };
}

test('requireAtomicCommit unset (default true) blocks the save when the provider lacks Contribution support', async () => {
  const store = installStore({ results: { 'form-a': 'ok', 'form-b': 'ok' } });
  try {
    await assert.rejects(
      clinicalTransactions.commitClinicalTransaction('txn-1', actor),
      (error) => { assert.equal(error.details?.code, 'CONTRIBUTION_UNSUPPORTED'); return true; },
    );
    assert.equal(store.getTransaction().status, 'failed');
    assert.equal(store.committedSessions.length, 0);
  } finally { store.restore(); }
});

test('requireAtomicCommit: false falls back to sequential commits and reports full success honestly (atomic: false)', async () => {
  const store = installStore({ requireAtomicCommit: false, results: { 'form-a': 'ok', 'form-b': 'ok' } });
  try {
    const result = await clinicalTransactions.commitClinicalTransaction('txn-1', actor);
    assert.equal(result.status, 'committed');
    assert.equal(result.atomic, false);
    assert.equal(result.contributionUid, undefined);
    assert.deepEqual(store.committedSessions.sort(), ['session-a', 'session-b']);
    assert.ok(store.getOperations().every((op) => op.status === 'committed'));
  } finally { store.restore(); }
});

test('a partial failure in the fallback never blocks the operations that did succeed, and is reported as "partial"', async () => {
  const store = installStore({ requireAtomicCommit: false, results: { 'form-a': 'ok', 'form-b': 'fail' } });
  try {
    const result = await clinicalTransactions.commitClinicalTransaction('txn-1', actor);
    assert.equal(result.status, 'partial');
    assert.equal(result.atomic, false);
    assert.deepEqual(store.committedSessions, ['session-a']);
    const ops = store.getOperations();
    assert.equal(ops.find((op) => op.formSessionId === 'session-a').status, 'committed');
    assert.equal(ops.find((op) => op.formSessionId === 'session-b').status, 'failed');
    assert.match(ops.find((op) => op.formSessionId === 'session-b').errorMessage, /simulated failure/);
  } finally { store.restore(); }
});

test('the fallback is reported as "failed" (not "partial") when every operation fails', async () => {
  const store = installStore({ requireAtomicCommit: false, results: { 'form-a': 'fail', 'form-b': 'fail' } });
  try {
    const result = await clinicalTransactions.commitClinicalTransaction('txn-1', actor);
    assert.equal(result.status, 'failed');
    assert.equal(store.committedSessions.length, 0);
  } finally { store.restore(); }
});

test('the global requireAtomicCommitByDefault: false also allows the fallback when the Composition itself sets nothing', async () => {
  const store = installStore({ requireAtomicCommitByDefault: false, results: { 'form-a': 'ok', 'form-b': 'ok' } });
  try {
    const result = await clinicalTransactions.commitClinicalTransaction('txn-1', actor);
    assert.equal(result.status, 'committed');
    assert.equal(result.atomic, false);
  } finally { store.restore(); }
});

test('a Composition-level requireAtomicCommit: true overrides a permissive global default', async () => {
  const store = installStore({ requireAtomicCommit: true, requireAtomicCommitByDefault: false, results: { 'form-a': 'ok', 'form-b': 'ok' } });
  try {
    await assert.rejects(
      clinicalTransactions.commitClinicalTransaction('txn-1', actor),
      (error) => { assert.equal(error.details?.code, 'CONTRIBUTION_UNSUPPORTED'); return true; },
    );
  } finally { store.restore(); }
});
