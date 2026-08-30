const assert = require('node:assert/strict');
const test = require('node:test');

// The connection-wide sessionReuseDefault (Configurable Settings roadmap,
// last open P1): an org-wide fallback for a form/Composition's own
// storageStrategy (OPEN_EHR_FORM_EXTENSION) when it sets nothing - see
// resolveSessionAlwaysNew in configService.ts. Per-form storageStrategy
// itself is already covered by session-reuse.test.js (forms) and
// composition-session.test.js (Compositions); this file only covers the new
// global-default fallback and its interaction with an explicit per-form
// setting.
const prisma = require('../dist/db/prisma').default;
const patients = require('../dist/services/patientService');
const aql = require('../dist/services/aqlFunctionService');
const configService = require('../dist/services/configService');
const formSessions = require('../dist/services/formSessionService');
const compositions = require('../dist/services/compositionSessionService');

const actor = { userId: 'clinician-1', authMode: 'local' };

const original = {
  formFindUnique: prisma.form.findUnique,
  formSessionFindMany: prisma.formSession.findMany,
  formSessionCreate: prisma.formSession.create,
  formSessionUpdate: prisma.formSession.update,
  resolvePatientReference: patients.resolvePatientReference,
  buildSessionRuntimeContext: aql.buildSessionRuntimeContext,
  getConfig: configService.getConfig,
  compositionFindFirst: prisma.compositionSession.findFirst,
  compositionCreate: prisma.compositionSession.create,
};

function vitalsForm(openEhrOptions) {
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

function installFormStore({ openEhrOptions, sessionReuseDefault } = {}) {
  const forms = new Map([['vitals-form', vitalsForm(openEhrOptions)]]);
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
  configService.getConfig = () => ({ ...(sessionReuseDefault !== undefined ? { sessionReuseDefault } : {}) });

  return {
    restore: () => {
      prisma.form.findUnique = original.formFindUnique;
      prisma.formSession.findMany = original.formSessionFindMany;
      prisma.formSession.create = original.formSessionCreate;
      prisma.formSession.update = original.formSessionUpdate;
      patients.resolvePatientReference = original.resolvePatientReference;
      aql.buildSessionRuntimeContext = original.buildSessionRuntimeContext;
      configService.getConfig = original.getConfig;
    },
  };
}

test("global sessionReuseDefault 'always-new' skips reuse for a form that sets no storageStrategy of its own", async () => {
  const store = installFormStore({ sessionReuseDefault: 'always-new' });
  try {
    const first = await formSessions.createFormSession({ formId: 'vitals-form', patientId: 'patient-1', mode: 'edit' }, actor);
    const second = await formSessions.createFormSession({ formId: 'vitals-form', patientId: 'patient-1', mode: 'edit' }, actor);
    assert.notEqual(second.id, first.id);
  } finally { store.restore(); }
});

test("an explicit per-form storageStrategy 'update_latest' overrides a global sessionReuseDefault of 'always-new'", async () => {
  const store = installFormStore({ openEhrOptions: { storageStrategy: 'update_latest' }, sessionReuseDefault: 'always-new' });
  try {
    const first = await formSessions.createFormSession({ formId: 'vitals-form', patientId: 'patient-1', mode: 'edit' }, actor);
    const second = await formSessions.createFormSession({ formId: 'vitals-form', patientId: 'patient-1', mode: 'edit' }, actor);
    assert.equal(second.id, first.id);
  } finally { store.restore(); }
});

test("an unset sessionReuseDefault still reuses (matches the 'reuse' default)", async () => {
  const store = installFormStore();
  try {
    const first = await formSessions.createFormSession({ formId: 'vitals-form', patientId: 'patient-1', mode: 'edit' }, actor);
    const second = await formSessions.createFormSession({ formId: 'vitals-form', patientId: 'patient-1', mode: 'edit' }, actor);
    assert.equal(second.id, first.id);
  } finally { store.restore(); }
});

function compositionForm(openEhrOptions) {
  return {
    id: 'composition-form', version: '2.0.0', status: 'published', canonical_json: {
      extensions: {
        'watehr.composition': { schemaVersion: '1.0', pages: [{ id: 'overview', title: 'Übersicht', blocks: [], layout: [] }] },
        ...(openEhrOptions ? { 'org.openehr.form': openEhrOptions } : {}),
      },
    },
  };
}

function installCompositionStore({ openEhrOptions, sessionReuseDefault } = {}) {
  const forms = new Map([['composition-form', compositionForm(openEhrOptions)]]);
  const records = new Map();
  let sequence = 0;
  const now = () => new Date('2026-08-27T10:00:00.000Z');

  prisma.form.findUnique = async ({ where }) => forms.get(where.id) || null;
  prisma.compositionSession.findFirst = async ({ where }) => [...records.values()].filter((record) => (
    record.compositionFormId === where.compositionFormId
    && record.patientId === where.patientId
    && record.patientNamespace === where.patientNamespace
    && record.userId === where.userId
    && record.mode === where.mode
    && where.status.in.includes(record.status)
  )).sort((left, right) => right.updatedAt - left.updatedAt)[0] || null;
  prisma.compositionSession.create = async ({ data }) => {
    sequence += 1;
    const record = { id: `composition-session-${sequence}`, ...data, childSessions: {}, revision: 0, createdAt: now(), updatedAt: now() };
    records.set(record.id, record);
    return { ...record, childSessions: { ...record.childSessions } };
  };
  patients.resolvePatientReference = async (patientId, namespace) => ({ patientId, patientNamespace: namespace, ehrId: `ehr-${patientId}`, origin: 'native' });
  configService.getConfig = () => ({ ...(sessionReuseDefault !== undefined ? { sessionReuseDefault } : {}) });

  return {
    restore: () => {
      prisma.form.findUnique = original.formFindUnique;
      prisma.compositionSession.findFirst = original.compositionFindFirst;
      prisma.compositionSession.create = original.compositionCreate;
      patients.resolvePatientReference = original.resolvePatientReference;
      configService.getConfig = original.getConfig;
    },
  };
}

test("global sessionReuseDefault 'always-new' skips reuse for a Composition that sets no storageStrategy of its own", async () => {
  const store = installCompositionStore({ sessionReuseDefault: 'always-new' });
  try {
    const first = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada', mode: 'edit' }, actor);
    const second = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada', mode: 'edit' }, actor);
    assert.notEqual(second.id, first.id);
  } finally { store.restore(); }
});

test("an explicit per-Composition storageStrategy 'update_latest' overrides a global sessionReuseDefault of 'always-new'", async () => {
  const store = installCompositionStore({ openEhrOptions: { storageStrategy: 'update_latest' }, sessionReuseDefault: 'always-new' });
  try {
    const first = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada', mode: 'edit' }, actor);
    const second = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada', mode: 'edit' }, actor);
    assert.equal(second.id, first.id);
  } finally { store.restore(); }
});
