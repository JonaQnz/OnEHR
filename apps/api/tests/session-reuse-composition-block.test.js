const assert = require('node:assert/strict');
const test = require('node:test');

// Live bug (2026-09-02): a Composition that wires the SAME Form Section into
// two different blocks (e.g. "Anamnese"'s "Diagnose 1"/"Diagnose 2", both on
// "Kodierte Diagnose" - one instance per diagnosis) had block-diagnosis-2's
// prefill launch silently reuse block-diagnosis-1's freshly-created session,
// because createFormSession's reuse search only keyed on
// formId+patientId+userId+mode - nothing block-aware. That overwrote
// Diagnose 1's value with Diagnose 2's, and the resulting duplicate
// operation against one shared FormSession then failed at save time as a
// real EHRbase version conflict ("One or more compositions changed since
// they were loaded"). This file covers createFormSession's compositionContext-
// scoped reuse fix directly: two blocks on the same Form Section must never
// share a session, but reopening the SAME block must still resume its own.
const prisma = require('../dist/db/prisma').default;
const patients = require('../dist/services/patientService');
const aql = require('../dist/services/aqlFunctionService');
const formSessions = require('../dist/services/formSessionService');

const actor = { userId: 'clinician-1', authMode: 'local' };
const original = {
  formFindUnique: prisma.form.findUnique,
  formSessionFindMany: prisma.formSession.findMany,
  formSessionFindUnique: prisma.formSession.findUnique,
  formSessionCreate: prisma.formSession.create,
  formSessionUpdate: prisma.formSession.update,
  compositionSessionFindUnique: prisma.compositionSession.findUnique,
  resolvePatientReference: patients.resolvePatientReference,
  buildSessionRuntimeContext: aql.buildSessionRuntimeContext,
};

function diagnosisForm() {
  return {
    id: 'diagnosis-form',
    version: '1.0.0',
    status: 'published',
    canonical_json: {
      id: 'diagnosis-form', name: 'Kodierte Diagnose', version: '1.0.0',
      sourceTemplates: [], layout: { type: 'form', children: [] }, bindings: {}, locales: {},
    },
  };
}

function compositionForm() {
  return {
    id: 'anamnese-form',
    version: '1.0.0',
    status: 'published',
    canonical_json: {
      id: 'anamnese-form', name: 'Anamnese', version: '1.0.0',
      sourceTemplates: [], layout: { type: 'form', children: [] }, bindings: {}, locales: {},
      extensions: {
        'watehr.composition': {
          schemaVersion: '1.0',
          pages: [{
            id: 'page-1', title: 'Vorerkrankungen',
            blocks: [
              { id: 'block-diagnosis-1', type: 'form', formId: 'diagnosis-form' },
              { id: 'block-diagnosis-2', type: 'form', formId: 'diagnosis-form' },
            ],
            layout: [
              { id: 'layout/page-1/block-diagnosis-1', blockId: 'block-diagnosis-1', element: 'block' },
              { id: 'layout/page-1/block-diagnosis-2', blockId: 'block-diagnosis-2', element: 'block' },
            ],
          }],
        },
      },
    },
  };
}

function installStore() {
  const forms = new Map([['diagnosis-form', diagnosisForm()], ['anamnese-form', compositionForm()]]);
  const sessions = new Map();
  const compositionSessions = new Map([
    ['comp-session-1', { id: 'comp-session-1', compositionFormId: 'anamnese-form', userId: actor.userId, childSessions: {} }],
  ]);
  let sequence = 0;
  const now = () => new Date('2026-09-02T10:00:00.000Z');

  prisma.form.findUnique = async ({ where }) => forms.get(where.id) || null;
  prisma.compositionSession.findUnique = async ({ where }) => compositionSessions.get(where.id) || null;
  prisma.formSession.findMany = async ({ where }) => [...sessions.values()].filter((row) => (
    row.formId === where.formId
    && row.patientId === where.patientId
    && row.patientNamespace === (where.patientNamespace ?? null)
    && row.userId === where.userId
    && row.mode === where.mode
    && !where.status.notIn.includes(row.status)
  )).sort((a, b) => b.updatedAt - a.updatedAt);
  prisma.formSession.findUnique = async ({ where }) => sessions.get(where.id) || null;
  prisma.formSession.create = async ({ data }) => {
    sequence += 1;
    const record = { id: `session-${sequence}`, ...data, revision: 0, createdAt: now(), updatedAt: now() };
    sessions.set(record.id, record);
    return record;
  };
  prisma.formSession.update = async ({ where, data }) => {
    const current = sessions.get(where.id);
    const record = { ...current, ...data, updatedAt: now() };
    sessions.set(record.id, record);
    return record;
  };
  patients.resolvePatientReference = async (patientId, namespace) => ({ patientId, patientNamespace: namespace, ehrId: `ehr-${patientId}`, origin: 'native' });
  aql.buildSessionRuntimeContext = async () => ({ aql: {}, codeFunctions: [] });

  return {
    sessions,
    attachChild: (blockId, sessionId) => {
      const comp = compositionSessions.get('comp-session-1');
      comp.childSessions = { ...comp.childSessions, [blockId]: sessionId };
    },
    restore: () => {
      prisma.form.findUnique = original.formFindUnique;
      prisma.compositionSession.findUnique = original.compositionSessionFindUnique;
      prisma.formSession.findMany = original.formSessionFindMany;
      prisma.formSession.findUnique = original.formSessionFindUnique;
      prisma.formSession.create = original.formSessionCreate;
      prisma.formSession.update = original.formSessionUpdate;
      patients.resolvePatientReference = original.resolvePatientReference;
      aql.buildSessionRuntimeContext = original.buildSessionRuntimeContext;
    },
  };
}

const compositionContext = (blockId) => ({ compositionSessionId: 'comp-session-1', blockId });

test('two different blocks on the same Form Section get separate sessions, not a shared one', async () => {
  const store = installStore();
  try {
    const first = await formSessions.createFormSession(
      { formId: 'diagnosis-form', patientId: 'patient-1', mode: 'prefill', compositionContext: compositionContext('block-diagnosis-1') },
      actor,
    );
    store.attachChild('block-diagnosis-1', first.id);
    const second = await formSessions.createFormSession(
      { formId: 'diagnosis-form', patientId: 'patient-1', mode: 'prefill', compositionContext: compositionContext('block-diagnosis-2') },
      actor,
    );
    assert.notEqual(second.id, first.id, 'block-diagnosis-2 must not reuse block-diagnosis-1\'s session');
  } finally { store.restore(); }
});

test('reopening the SAME block still resumes its own previously-attached session', async () => {
  const store = installStore();
  try {
    const first = await formSessions.createFormSession(
      { formId: 'diagnosis-form', patientId: 'patient-1', mode: 'prefill', compositionContext: compositionContext('block-diagnosis-1') },
      actor,
    );
    store.attachChild('block-diagnosis-1', first.id);
    const again = await formSessions.createFormSession(
      { formId: 'diagnosis-form', patientId: 'patient-1', mode: 'prefill', compositionContext: compositionContext('block-diagnosis-1') },
      actor,
    );
    assert.equal(again.id, first.id, 'reopening the same block must resume its own session');
  } finally { store.restore(); }
});

test('a block with nothing attached yet never falls back to a same-form session belonging to another block', async () => {
  const store = installStore();
  try {
    const first = await formSessions.createFormSession(
      { formId: 'diagnosis-form', patientId: 'patient-1', mode: 'prefill', compositionContext: compositionContext('block-diagnosis-1') },
      actor,
    );
    store.attachChild('block-diagnosis-1', first.id);
    // block-diagnosis-2 launches without ever having been attached before -
    // must create fresh, never grab block-diagnosis-1's session via the old
    // broad formId+patientId+userId+mode search.
    const second = await formSessions.createFormSession(
      { formId: 'diagnosis-form', patientId: 'patient-1', mode: 'prefill', compositionContext: compositionContext('block-diagnosis-2') },
      actor,
    );
    assert.notEqual(second.id, first.id);
    assert.equal(store.sessions.size, 2);
  } finally { store.restore(); }
});
