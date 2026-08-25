const assert = require('node:assert/strict');
const test = require('node:test');

const prisma = require('../dist/db/prisma').default;
const patients = require('../dist/services/patientService');
const formSessions = require('../dist/services/formSessionService');
const compositions = require('../dist/services/compositionSessionService');

const actor = { userId: 'clinician-1', authMode: 'local' };
const original = {
  formFindUnique: prisma.form.findUnique,
  compositionFindFirst: prisma.compositionSession.findFirst,
  compositionFindUnique: prisma.compositionSession.findUnique,
  compositionCreate: prisma.compositionSession.create,
  compositionUpdate: prisma.compositionSession.update,
  formSessionFindMany: prisma.formSession.findMany,
  resolvePatientReference: patients.resolvePatientReference,
  getFormSession: formSessions.getFormSession,
  validateFormSession: formSessions.validateFormSession,
};

function compositionForm(blocks = [{ id: 'person', type: 'form', formId: 'person-form', title: 'Person' }]) {
  return {
    id: 'composition-form', version: '2.0.0', status: 'published', canonical_json: {
      extensions: { 'watehr.composition': {
        schemaVersion: '1.0',
        pages: [{ id: 'overview', title: 'Übersicht', blocks, layout: blocks.map((block) => ({ id: `slot-${block.id}`, element: 'block', blockId: block.id })) }],
      } },
    },
  };
}

function installStore({ blocks } = {}) {
  const records = new Map();
  const childRows = new Map();
  let sequence = 0;
  const forms = new Map([['composition-form', compositionForm(blocks)]]);
  const now = () => new Date('2026-08-05T10:00:00.000Z');
  const clone = (value) => ({ ...value, childSessions: { ...value.childSessions } });

  prisma.form.findUnique = async ({ where }) => forms.get(where.id) || null;
  prisma.compositionSession.findFirst = async ({ where }) => [...records.values()].filter((record) => (
    record.compositionFormId === where.compositionFormId
    && record.patientId === where.patientId
    && record.patientNamespace === where.patientNamespace
    && record.userId === where.userId
    && record.mode === where.mode
    && where.status.in.includes(record.status)
  )).sort((left, right) => right.updatedAt - left.updatedAt)[0] || null;
  prisma.compositionSession.findUnique = async ({ where }) => records.get(where.id) || null;
  prisma.compositionSession.create = async ({ data }) => {
    sequence += 1;
    const record = { id: `composition-session-${sequence}`, ...data, revision: 0, createdAt: now(), updatedAt: now() };
    records.set(record.id, record);
    return clone(record);
  };
  prisma.compositionSession.update = async ({ where, data }) => {
    const current = records.get(where.id);
    if (!current) throw new Error('missing composition session');
    const record = {
      ...current,
      ...data,
      revision: data.revision?.increment ? current.revision + data.revision.increment : (data.revision ?? current.revision),
      updatedAt: now(),
    };
    records.set(record.id, record);
    return clone(record);
  };
  prisma.formSession.findMany = async ({ where }) => where.id.in.map((id) => childRows.get(id)).filter(Boolean);
  patients.resolvePatientReference = async (patientId, namespace) => ({ patientId: patientId === 'local-ada' ? 'ada-1' : patientId, patientNamespace: namespace || 'tenant-a', ehrId: `ehr-${patientId}` });
  formSessions.getFormSession = async (id) => {
    const row = childRows.get(id);
    if (!row) throw new Error('missing child session');
    return { ...row, patientId: 'ada-1' };
  };
  formSessions.validateFormSession = async (id) => {
    const current = childRows.get(id);
    childRows.set(id, { ...current, status: 'ready', validation: [] });
    return { valid: true };
  };

  return { records, childRows, restore: () => {
    prisma.form.findUnique = original.formFindUnique;
    prisma.compositionSession.findFirst = original.compositionFindFirst;
    prisma.compositionSession.findUnique = original.compositionFindUnique;
    prisma.compositionSession.create = original.compositionCreate;
    prisma.compositionSession.update = original.compositionUpdate;
    prisma.formSession.findMany = original.formSessionFindMany;
    patients.resolvePatientReference = original.resolvePatientReference;
    formSessions.getFormSession = original.getFormSession;
    formSessions.validateFormSession = original.validateFormSession;
  } };
}

test('composition session resumes a draft for the same canonical patient and namespace', async () => {
  const store = installStore();
  try {
    const first = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada', patientNamespace: 'tenant-a', mode: 'edit' }, actor);
    const resumed = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada', patientNamespace: 'tenant-a', mode: 'edit' }, actor);
    const otherNamespace = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada', patientNamespace: 'tenant-b', mode: 'edit' }, actor);

    assert.equal(first.patientId, 'ada-1');
    assert.equal(first.status, 'draft');
    assert.equal(first.children[0].status, 'not_started');
    assert.equal(resumed.id, first.id);
    assert.notEqual(otherNamespace.id, first.id);
  } finally { store.restore(); }
});

test('attaching, validating and submitting child forms updates the parent progress', async () => {
  const store = installStore();
  try {
    const parent = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada' }, actor);
    store.childRows.set('child-1', { id: 'child-1', formId: 'person-form', status: 'draft', validation: [] });
    const attached = await compositions.attachCompositionChild(parent.id, 'person', 'child-1', actor);
    assert.equal(attached.status, 'in_progress');
    assert.equal(attached.progress.started, 1);

    const validated = await compositions.validateCompositionSession(parent.id, actor);
    assert.equal(validated.valid, true);
    assert.equal(validated.session.status, 'ready');

    store.childRows.set('child-1', { ...store.childRows.get('child-1'), status: 'submitted' });
    const completed = await compositions.getCompositionSession(parent.id, actor);
    assert.equal(completed.status, 'submitted');
    assert.equal(completed.progress.submitted, 1);
  } finally { store.restore(); }
});

test('a Composition never attaches a child session from another form or patient', async () => {
  const store = installStore();
  try {
    const parent = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada' }, actor);
    store.childRows.set('wrong-child', { id: 'wrong-child', formId: 'different-form', status: 'draft', validation: [] });
    await assert.rejects(
      compositions.attachCompositionChild(parent.id, 'person', 'wrong-child', actor),
      /does not match this composition context/i,
    );
  } finally { store.restore(); }
});
