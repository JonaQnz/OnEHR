const assert = require('node:assert/strict');
const test = require('node:test');

// Per-form storageStrategy ('always_new' | 'update_latest', the
// OPEN_EHR_FORM_EXTENSION already defined in openehr-engine/index.ts) -
// covers createFormSession's reuse-vs-always-new decision. The mirrored
// startCompositionSession behavior is covered in composition-session.test.js.
const prisma = require('../dist/db/prisma').default;
const patients = require('../dist/services/patientService');
const aql = require('../dist/services/aqlFunctionService');
const formSessions = require('../dist/services/formSessionService');

const actor = { userId: 'clinician-1', authMode: 'local' };
const original = {
  formFindUnique: prisma.form.findUnique,
  formSessionFindMany: prisma.formSession.findMany,
  formSessionCreate: prisma.formSession.create,
  formSessionUpdate: prisma.formSession.update,
  resolvePatientReference: patients.resolvePatientReference,
  buildSessionRuntimeContext: aql.buildSessionRuntimeContext,
};

function baseForm(openEhrOptions) {
  return {
    id: 'vitals-form',
    version: '1.0.0',
    status: 'published',
    canonical_json: {
      id: 'vitals-form',
      name: 'Vitals',
      version: '1.0.0',
      sourceTemplates: [],
      layout: { type: 'form', children: [] },
      bindings: {},
      locales: {},
      // Session reuse/storageStrategy is orthogonal to Form Section vs.
      // Form (Composition) - marking this fixture a Composition just
      // satisfies createFormSession's "can't launch a bare Form Section
      // standalone" guard without affecting anything this file tests.
      extensions: {
        'watehr.composition': { schemaVersion: 1, pages: [] },
        ...(openEhrOptions ? { 'org.openehr.form': openEhrOptions } : {}),
      },
    },
  };
}

function installStore({ openEhrOptions } = {}) {
  const forms = new Map([['vitals-form', baseForm(openEhrOptions)]]);
  const sessions = new Map();
  let sequence = 0;
  const now = () => new Date('2026-08-27T10:00:00.000Z');

  prisma.form.findUnique = async ({ where }) => forms.get(where.id) || null;
  prisma.formSession.findMany = async ({ where }) => [...sessions.values()].filter((row) => (
    row.formId === where.formId
    && row.patientId === where.patientId
    && row.patientNamespace === (where.patientNamespace ?? null)
    && row.userId === where.userId
    && row.mode === where.mode
    && !where.status.notIn.includes(row.status)
  )).sort((a, b) => b.updatedAt - a.updatedAt);
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
    restore: () => {
      prisma.form.findUnique = original.formFindUnique;
      prisma.formSession.findMany = original.formSessionFindMany;
      prisma.formSession.create = original.formSessionCreate;
      prisma.formSession.update = original.formSessionUpdate;
      patients.resolvePatientReference = original.resolvePatientReference;
      aql.buildSessionRuntimeContext = original.buildSessionRuntimeContext;
    },
  };
}

test('edit-mode session is reused by default (implicit storageStrategy "update_latest")', async () => {
  const store = installStore();
  try {
    const first = await formSessions.createFormSession({ formId: 'vitals-form', patientId: 'patient-1', mode: 'edit' }, actor);
    const second = await formSessions.createFormSession({ formId: 'vitals-form', patientId: 'patient-1', mode: 'edit' }, actor);
    assert.equal(second.id, first.id);
  } finally { store.restore(); }
});

test('storageStrategy "always_new" skips reuse even in edit mode', async () => {
  const store = installStore({ openEhrOptions: { storageStrategy: 'always_new' } });
  try {
    const first = await formSessions.createFormSession({ formId: 'vitals-form', patientId: 'patient-1', mode: 'edit' }, actor);
    const second = await formSessions.createFormSession({ formId: 'vitals-form', patientId: 'patient-1', mode: 'edit' }, actor);
    assert.notEqual(second.id, first.id);
  } finally { store.restore(); }
});

test('storageStrategy "always_new" also applies to prefill mode', async () => {
  const store = installStore({ openEhrOptions: { storageStrategy: 'always_new' } });
  try {
    const first = await formSessions.createFormSession({ formId: 'vitals-form', patientId: 'patient-1', mode: 'prefill' }, actor);
    const second = await formSessions.createFormSession({ formId: 'vitals-form', patientId: 'patient-1', mode: 'prefill' }, actor);
    assert.notEqual(second.id, first.id);
  } finally { store.restore(); }
});

test('create mode never reuses regardless of storageStrategy (unaffected either way)', async () => {
  const store = installStore({ openEhrOptions: { storageStrategy: 'always_new' } });
  try {
    const first = await formSessions.createFormSession({ formId: 'vitals-form', patientId: 'patient-1', mode: 'create' }, actor);
    const second = await formSessions.createFormSession({ formId: 'vitals-form', patientId: 'patient-1', mode: 'create' }, actor);
    assert.notEqual(second.id, first.id);
  } finally { store.restore(); }
});

test('an explicit forceNew still skips reuse under the default storageStrategy', async () => {
  const store = installStore();
  try {
    const first = await formSessions.createFormSession({ formId: 'vitals-form', patientId: 'patient-1', mode: 'edit' }, actor);
    const second = await formSessions.createFormSession({ formId: 'vitals-form', patientId: 'patient-1', mode: 'edit', forceNew: true }, actor);
    assert.notEqual(second.id, first.id);
  } finally { store.restore(); }
});
