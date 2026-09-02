const assert = require('node:assert/strict');
const test = require('node:test');

// Atomic (Contribution-backed) commit path of commitClinicalTransaction -
// the sibling of clinical-transaction-fallback.test.js's non-atomic
// fallback, exercised here with supportsContribution: true so builtOperations
// (the desiredChangeType/precedingVersionUid pair actually sent to EHRbase)
// is under test, not just the outer commit/fail bookkeeping.
const prisma = require('../dist/db/prisma').default;
const compositionSessions = require('../dist/services/compositionSessionService');
const compositionRepo = require('../dist/services/compositionRepository');
const formSessions = require('../dist/services/formSessionService');
const ehrbaseService = require('../dist/services/ehrbaseService');
const clinicalTransactions = require('../dist/services/clinicalTransactionService');
// openehr-engine's own index.js re-exports buildCanonicalComposition via a
// getter-only accessor (`export { buildCanonicalComposition } from
// './canonicalComposition'` compiles to Object.defineProperty with a getter
// and no setter) - reassigning it through the package entrypoint silently
// no-ops. The getter reads canonicalComposition.js's own module object on
// every access though, and that submodule exports it as a plain writable
// `exports.buildCanonicalComposition = ...`, so mocking it there is what
// clinicalTransactionService (which only ever goes through the index.js
// getter) actually observes.
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
  clinicalTransactionOperationUpdate: prisma.clinicalTransactionOperation.update,
  getCompositionSession: compositionSessions.getCompositionSession,
  getCompositionRepository: compositionRepo.getCompositionRepository,
  applySuccessfulProviderCommit: formSessions.applySuccessfulProviderCommit,
  getRemoteWebTemplate: ehrbaseService.getRemoteWebTemplate,
  buildCanonicalComposition: canonicalCompositionModule.buildCanonicalComposition,
};

function childForm(id) {
  return { id, version: '1.0.0', canonical_json: { id, name: id, version: '1.0.0', sourceTemplates: [{ id: 'tpl.v1', alias: 'tpl', type: 'openEhrWebTemplate' }], layout: { type: 'form', children: [] }, bindings: {}, locales: {} } };
}

/**
 * @param baseVersionUids per-op captured-at-prepare-time base, e.g. { a: 'draft-a::sys::1' }
 * @param sessionReferences per-session current EHRbase state at commit time
 */
function installStore({ baseVersionUids = {}, sessionReferences = {} } = {}) {
  const forms = new Map([['form-a', childForm('form-a')], ['form-b', childForm('form-b')]]);
  const now = () => new Date('2026-09-02T10:00:00.000Z');
  let transaction = {
    id: 'txn-1', compositionSessionId: 'session-1', ehrId: 'ehr-1', userId: actor.userId, authMode: actor.authMode,
    status: 'ready', description: null, contributionUid: null, atomic: null, errorCode: null, errorMessage: null,
    revision: 0, createdAt: now(), updatedAt: now(),
  };
  let operations = [
    { id: 'op-a', transactionId: 'txn-1', formSessionId: 'session-a', blockId: 'block-a', type: 'create', baseVersionUid: baseVersionUids.a ?? null, resultVersionUid: null, status: 'ready', changeDescription: null, errorCode: null, errorMessage: null, createdAt: now(), updatedAt: now() },
    { id: 'op-b', transactionId: 'txn-1', formSessionId: 'session-b', blockId: 'block-b', type: 'create', baseVersionUid: baseVersionUids.b ?? null, resultVersionUid: null, status: 'ready', changeDescription: null, errorCode: null, errorMessage: null, createdAt: now(), updatedAt: now() },
  ];
  const sessionRows = new Map([
    ['session-a', { id: 'session-a', formId: 'form-a', values: { field: 'a' }, draftReference: null, providerReference: null, ...sessionReferences.a }],
    ['session-b', { id: 'session-b', formId: 'form-b', values: { field: 'b' }, draftReference: null, providerReference: null, ...sessionReferences.b }],
  ]);
  const committedSessions = [];
  const commitContributionCalls = [];

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
  compositionSessions.getCompositionSession = async () => ({ id: 'session-1', compositionFormId: 'composition-form', patientId: 'patient-1', patientNamespace: 'default' });
  ehrbaseService.getRemoteWebTemplate = async () => ({ tree: {} });
  canonicalCompositionModule.buildCanonicalComposition = () => ({ _type: 'COMPOSITION', name: { value: 'Test' } });
  compositionRepo.getCompositionRepository = () => ({
    supportsContribution: true,
    commitContribution: async (input) => {
      commitContributionCalls.push(input);
      return { contributionUid: 'contribution-1', versions: input.operations.map((op) => ({ operationIndex: op.operationIndex, versionUid: `result-${op.operationIndex}::sys::1` })) };
    },
  });
  formSessions.applySuccessfulProviderCommit = async (sessionId) => { committedSessions.push(sessionId); return {}; };

  return {
    committedSessions,
    commitContributionCalls,
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
      compositionSessions.getCompositionSession = original.getCompositionSession;
      compositionRepo.getCompositionRepository = original.getCompositionRepository;
      formSessions.applySuccessfulProviderCommit = original.applySuccessfulProviderCommit;
      ehrbaseService.getRemoteWebTemplate = original.getRemoteWebTemplate;
      canonicalCompositionModule.buildCanonicalComposition = original.buildCanonicalComposition;
    },
  };
}

// Live bug (2026-09-02), second half: once the false-positive concurrency
// conflict (see clinical-transaction-fallback.test.js) was fixed, saving a
// freshly-filled multi-block Form still failed - this time with EHRbase
// itself rejecting the request: "Invalid version. Change type CREATION, but
// also set 'preceding_version_uid' attribute". A 'create'-typed operation
// (lifecycleState not yet 'complete') whose session already has an
// autosaved draft legitimately carries a non-null baseVersionUid, but the
// atomic path was always sending desiredChangeType 'creation' for any
// 'create'-typed op regardless - a combination openEHR/EHRbase itself
// forbids, since CREATION means "no predecessor" by definition.
test('a "create" op with an existing draft (baseVersionUid set) is sent to EHRbase as a modification, not a creation', async () => {
  const store = installStore({
    baseVersionUids: { a: 'draft-a::sys::1', b: null },
    sessionReferences: { a: { draftReference: 'draft-a::sys::1' } },
  });
  try {
    const result = await clinicalTransactions.commitClinicalTransaction('txn-1', actor);
    assert.equal(result.status, 'committed');
    assert.equal(store.commitContributionCalls.length, 1);
    const [sentA, sentB] = store.commitContributionCalls[0].operations;
    assert.equal(sentA.precedingVersionUid, 'draft-a::sys::1');
    assert.equal(sentA.desiredChangeType, 'modification');
    // b never had a draft - a genuine first version, still sent as creation.
    assert.equal(sentB.precedingVersionUid, undefined);
    assert.equal(sentB.desiredChangeType, 'creation');
    assert.deepEqual(store.committedSessions.sort(), ['session-a', 'session-b']);
  } finally { store.restore(); }
});

test('a "create" op with no prior draft at all is still sent as a genuine creation (no preceding_version_uid)', async () => {
  const store = installStore({ baseVersionUids: { a: null, b: null } });
  try {
    const result = await clinicalTransactions.commitClinicalTransaction('txn-1', actor);
    assert.equal(result.status, 'committed');
    const [sentA, sentB] = store.commitContributionCalls[0].operations;
    assert.equal(sentA.desiredChangeType, 'creation');
    assert.equal(sentA.precedingVersionUid, undefined);
    assert.equal(sentB.desiredChangeType, 'creation');
    assert.equal(sentB.precedingVersionUid, undefined);
  } finally { store.restore(); }
});
