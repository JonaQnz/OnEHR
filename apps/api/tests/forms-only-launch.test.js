const assert = require('node:assert/strict');
const test = require('node:test');

// A bare Form Section (kind "form" - no watehr.composition extension) can
// never be launched/created standalone for a patient via
// createFormSession/launchForm - only as a block already wired into a
// running Composition session, proven via a server-verified
// compositionContext, not a client-trusted flag. startCompositionSession's
// own equivalent guard (rejecting a non-Composition compositionFormId) is
// pre-existing and covered by composition-session.test.js.
const prisma = require('../dist/db/prisma').default;
const patients = require('../dist/services/patientService');
const aql = require('../dist/services/aqlFunctionService');
const formSessions = require('../dist/services/formSessionService');
const compositions = require('../dist/services/compositionSessionService');

const actor = { userId: 'clinician-1', authMode: 'local' };
const otherActor = { userId: 'someone-else', authMode: 'local' };
const original = {
  formFindUnique: prisma.form.findUnique,
  compositionFindFirst: prisma.compositionSession.findFirst,
  compositionFindUnique: prisma.compositionSession.findUnique,
  compositionCreate: prisma.compositionSession.create,
  compositionUpdate: prisma.compositionSession.update,
  compositionUpdateMany: prisma.compositionSession.updateMany,
  formSessionFindMany: prisma.formSession.findMany,
  formSessionCreate: prisma.formSession.create,
  formSessionUpdate: prisma.formSession.update,
  resolvePatientReference: patients.resolvePatientReference,
  buildSessionRuntimeContext: aql.buildSessionRuntimeContext,
};

function formSectionForm(id, { parentId = id, status = 'published' } = {}) {
  return {
    id, parent_id: parentId, version: '1.0.0', status,
    canonical_json: { id, name: 'Vitals', version: '1.0.0', sourceTemplates: [], layout: { type: 'form', children: [] }, bindings: {}, locales: {} },
  };
}

function compositionForm(blocks = [{ id: 'vitals-block', type: 'form', formId: 'vitals-form-section' }]) {
  return {
    id: 'discharge-composition', version: '2.0.0', status: 'published',
    canonical_json: {
      id: 'discharge-composition', name: 'Entlassung', version: '2.0.0', sourceTemplates: [],
      layout: { type: 'form', children: [{ type: 'container', children: [] }] }, bindings: {}, locales: { en: {} },
      extensions: {
        'watehr.composition': {
          schemaVersion: '1.0',
          pages: [{ id: 'overview', title: 'Übersicht', blocks, layout: blocks.map((block) => ({ id: `slot-${block.id}`, element: 'block', blockId: block.id })) }],
        },
      },
    },
  };
}

function installStore() {
  const forms = new Map([
    ['vitals-form-section', formSectionForm('vitals-form-section')],
    ['unrelated-form-section', formSectionForm('unrelated-form-section')],
    ['discharge-composition', compositionForm()],
  ]);
  const compositionRecords = new Map();
  const formSessionRecords = new Map();
  let compositionSequence = 0;
  let formSessionSequence = 0;
  const now = () => new Date('2026-08-30T10:00:00.000Z');

  prisma.form.findUnique = async ({ where }) => forms.get(where.id) || null;
  prisma.compositionSession.findFirst = async () => null; // every startCompositionSession call here is a fresh one
  prisma.compositionSession.findUnique = async ({ where }) => compositionRecords.get(where.id) || null;
  prisma.compositionSession.create = async ({ data }) => {
    compositionSequence += 1;
    const record = { id: `composition-session-${compositionSequence}`, ...data, revision: 0, createdAt: now(), updatedAt: now() };
    compositionRecords.set(record.id, record);
    return { ...record, childSessions: { ...record.childSessions } };
  };
  prisma.compositionSession.update = async ({ where, data }) => {
    const current = compositionRecords.get(where.id);
    const record = { ...current, ...data, updatedAt: now() };
    compositionRecords.set(record.id, record);
    return { ...record, childSessions: { ...record.childSessions } };
  };
  prisma.compositionSession.updateMany = async ({ where, data }) => {
    const current = compositionRecords.get(where.id);
    if (!current || (where.revision !== undefined && current.revision !== where.revision)) return { count: 0 };
    const record = { ...current, ...data, updatedAt: now() };
    compositionRecords.set(record.id, record);
    return { count: 1 };
  };
  prisma.formSession.findMany = async ({ where }) => {
    if (where?.id?.in) return where.id.in.map((id) => formSessionRecords.get(id)).filter(Boolean);
    return [];
  };
  prisma.formSession.create = async ({ data }) => {
    formSessionSequence += 1;
    const record = { id: `form-session-${formSessionSequence}`, ...data, revision: 0, createdAt: now(), updatedAt: now() };
    formSessionRecords.set(record.id, record);
    return record;
  };
  prisma.formSession.update = async ({ where, data }) => {
    const current = formSessionRecords.get(where.id);
    const record = { ...current, ...data, updatedAt: now() };
    formSessionRecords.set(record.id, record);
    return record;
  };
  patients.resolvePatientReference = async (patientId, namespace) => ({ patientId, patientNamespace: namespace, ehrId: `ehr-${patientId}`, origin: 'native' });
  aql.buildSessionRuntimeContext = async () => ({ aql: {}, codeFunctions: [] });

  return {
    restore: () => {
      prisma.form.findUnique = original.formFindUnique;
      prisma.compositionSession.findFirst = original.compositionFindFirst;
      prisma.compositionSession.findUnique = original.compositionFindUnique;
      prisma.compositionSession.create = original.compositionCreate;
      prisma.compositionSession.update = original.compositionUpdate;
      prisma.compositionSession.updateMany = original.compositionUpdateMany;
      prisma.formSession.findMany = original.formSessionFindMany;
      prisma.formSession.create = original.formSessionCreate;
      prisma.formSession.update = original.formSessionUpdate;
      patients.resolvePatientReference = original.resolvePatientReference;
      aql.buildSessionRuntimeContext = original.buildSessionRuntimeContext;
    },
  };
}

test('a bare Form Section cannot be launched standalone for a patient (no compositionContext)', async () => {
  const store = installStore();
  try {
    await assert.rejects(
      formSessions.createFormSession({ formId: 'vitals-form-section', patientId: 'patient-1' }, actor),
      (err) => { assert.equal(err.status, 409); assert.match(err.message, /Form Section, not a Form/i); return true; },
    );
  } finally { store.restore(); }
});

test('a Form (Composition) can still be launched directly, unaffected', async () => {
  const store = installStore();
  try {
    const session = await formSessions.createFormSession({ formId: 'discharge-composition', patientId: 'patient-1' }, actor);
    assert.equal(session.formId, 'discharge-composition');
  } finally { store.restore(); }
});

test('compositionContext pointing at a nonexistent composition session is rejected', async () => {
  const store = installStore();
  try {
    await assert.rejects(
      formSessions.createFormSession({ formId: 'vitals-form-section', patientId: 'patient-1', compositionContext: { compositionSessionId: 'no-such-session', blockId: 'vitals-block' } }, actor),
      (err) => { assert.equal(err.status, 404); return true; },
    );
  } finally { store.restore(); }
});

test('compositionContext referencing another user\'s composition session is rejected', async () => {
  const store = installStore();
  try {
    const parent = await compositions.startCompositionSession({ compositionFormId: 'discharge-composition', patientId: 'patient-1' }, actor);
    await assert.rejects(
      formSessions.createFormSession({ formId: 'vitals-form-section', patientId: 'patient-1', compositionContext: { compositionSessionId: parent.id, blockId: 'vitals-block' } }, otherActor),
      (err) => { assert.equal(err.status, 403); return true; },
    );
  } finally { store.restore(); }
});

test('compositionContext with an unknown blockId is rejected', async () => {
  const store = installStore();
  try {
    const parent = await compositions.startCompositionSession({ compositionFormId: 'discharge-composition', patientId: 'patient-1' }, actor);
    await assert.rejects(
      formSessions.createFormSession({ formId: 'vitals-form-section', patientId: 'patient-1', compositionContext: { compositionSessionId: parent.id, blockId: 'no-such-block' } }, actor),
      (err) => { assert.equal(err.status, 422); return true; },
    );
  } finally { store.restore(); }
});

test('compositionContext whose block declares a different formId is rejected - can\'t launch an unrelated Form Section under someone else\'s block', async () => {
  const store = installStore();
  try {
    const parent = await compositions.startCompositionSession({ compositionFormId: 'discharge-composition', patientId: 'patient-1' }, actor);
    await assert.rejects(
      formSessions.createFormSession({ formId: 'unrelated-form-section', patientId: 'patient-1', compositionContext: { compositionSessionId: parent.id, blockId: 'vitals-block' } }, actor),
      (err) => { assert.equal(err.status, 422); assert.match(err.message, /not a block of the referenced composition session/i); return true; },
    );
  } finally { store.restore(); }
});

test('a genuinely matching compositionContext allows launching the Form Section block', async () => {
  const store = installStore();
  try {
    const parent = await compositions.startCompositionSession({ compositionFormId: 'discharge-composition', patientId: 'patient-1' }, actor);
    const child = await formSessions.createFormSession(
      { formId: 'vitals-form-section', patientId: 'patient-1', compositionContext: { compositionSessionId: parent.id, blockId: 'vitals-block' } },
      actor,
    );
    assert.equal(child.formId, 'vitals-form-section');
  } finally { store.restore(); }
});

// The composition's own block config (extensions["watehr.composition"])
// stores whatever formId was current when the block was authored - a Form
// Section republish (create_form_draft/publish_form) archives that exact
// row and mints a new one under the same parent_id. launchForm's own
// latest-published resolution (form-launch-published-resolution.test.js)
// already hands createFormSession the NEW row's id, not the block's
// original one - this exact-match check must accept that as the same
// block, not reject it as "not a block of the referenced composition
// session". Confirmed live (2026-09-02) against "Person (Basis)".
test('a Form Section republished under the same parent_id is still recognized as the block\'s Form Section', async () => {
  const store = installStore();
  const forms = {
    'vitals-form-section': formSectionForm('vitals-form-section', { status: 'archived' }),
    'vitals-form-section-v2': formSectionForm('vitals-form-section-v2', { parentId: 'vitals-form-section' }),
    'unrelated-form-section': formSectionForm('unrelated-form-section'),
    'discharge-composition': compositionForm(),
  };
  const originalFindUnique = prisma.form.findUnique;
  prisma.form.findUnique = async ({ where }) => forms[where.id] || null;
  try {
    const parent = await compositions.startCompositionSession({ compositionFormId: 'discharge-composition', patientId: 'patient-1' }, actor);
    const child = await formSessions.createFormSession(
      { formId: 'vitals-form-section-v2', patientId: 'patient-1', compositionContext: { compositionSessionId: parent.id, blockId: 'vitals-block' } },
      actor,
    );
    assert.equal(child.formId, 'vitals-form-section-v2');
  } finally { prisma.form.findUnique = originalFindUnique; store.restore(); }
});

test('a Form Section from a genuinely different lineage is still rejected, even if its own parent_id happens to be unset', async () => {
  const store = installStore();
  const forms = {
    'vitals-form-section': formSectionForm('vitals-form-section', { status: 'archived' }),
    'unrelated-form-section-v2': formSectionForm('unrelated-form-section-v2', { parentId: 'unrelated-form-section' }),
    'unrelated-form-section': formSectionForm('unrelated-form-section'),
    'discharge-composition': compositionForm(),
  };
  const originalFindUnique = prisma.form.findUnique;
  prisma.form.findUnique = async ({ where }) => forms[where.id] || null;
  try {
    const parent = await compositions.startCompositionSession({ compositionFormId: 'discharge-composition', patientId: 'patient-1' }, actor);
    await assert.rejects(
      formSessions.createFormSession(
        { formId: 'unrelated-form-section-v2', patientId: 'patient-1', compositionContext: { compositionSessionId: parent.id, blockId: 'vitals-block' } },
        actor,
      ),
      (err) => { assert.equal(err.status, 422); return true; },
    );
  } finally { prisma.form.findUnique = originalFindUnique; store.restore(); }
});
