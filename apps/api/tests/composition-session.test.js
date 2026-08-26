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
  compositionUpdateMany: prisma.compositionSession.updateMany,
  formSessionFindMany: prisma.formSession.findMany,
  resolvePatientReference: patients.resolvePatientReference,
  getFormSession: formSessions.getFormSession,
  validateFormSession: formSessions.validateFormSession,
};

function compositionForm(blocks = [{ id: 'person', type: 'form', formId: 'person-form', title: 'Person' }], openEhrOptions) {
  return {
    id: 'composition-form', version: '2.0.0', status: 'published', canonical_json: {
      extensions: {
        'watehr.composition': {
          schemaVersion: '1.0',
          pages: [{ id: 'overview', title: 'Übersicht', blocks, layout: blocks.map((block) => ({ id: `slot-${block.id}`, element: 'block', blockId: block.id })) }],
        },
        ...(openEhrOptions ? { 'org.openehr.form': openEhrOptions } : {}),
      },
    },
  };
}

function installStore({ blocks, openEhrOptions } = {}) {
  const records = new Map();
  const childRows = new Map();
  let sequence = 0;
  const forms = new Map([['composition-form', compositionForm(blocks, openEhrOptions)]]);
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
  // Mirrors real Postgres semantics for the one shape attachCompositionChild
  // actually uses: a conditional update gated by a where.revision match,
  // returning how many rows it actually touched (0 or 1 here, since id is
  // unique) - this is what lets a concurrency test genuinely exercise the
  // "someone else updated first" retry path instead of always succeeding.
  prisma.compositionSession.updateMany = async ({ where, data }) => {
    const current = records.get(where.id);
    if (!current || (where.revision !== undefined && current.revision !== where.revision)) return { count: 0 };
    const record = {
      ...current,
      ...data,
      revision: data.revision?.increment ? current.revision + data.revision.increment : (data.revision ?? current.revision),
      updatedAt: now(),
    };
    records.set(record.id, record);
    return { count: 1 };
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
    prisma.compositionSession.updateMany = original.compositionUpdateMany;
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

test('storageStrategy "always_new" on the Composition form skips resuming an open session', async () => {
  const store = installStore({ openEhrOptions: { storageStrategy: 'always_new' } });
  try {
    const first = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada', patientNamespace: 'tenant-a', mode: 'edit' }, actor);
    const second = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada', patientNamespace: 'tenant-a', mode: 'edit' }, actor);
    assert.notEqual(second.id, first.id);
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

test('two blocks attaching at the same time never drop one another\'s attachment', async () => {
  const blocks = [{ id: 'person', type: 'form', formId: 'person-form', title: 'Person' }, { id: 'diagnosis', type: 'form', formId: 'diagnosis-form', title: 'Diagnose' }];
  const store = installStore({ blocks });
  try {
    const parent = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada' }, actor);
    store.childRows.set('child-person', { id: 'child-person', formId: 'person-form', status: 'draft', validation: [] });
    store.childRows.set('child-diagnosis', { id: 'child-diagnosis', formId: 'diagnosis-form', status: 'draft', validation: [] });

    // Both start from the same revision - the read-modify-write race this
    // guards against (e.g. the same Composition open in two tabs, or two
    // form iframes both finishing their launch around the same time).
    await Promise.all([
      compositions.attachCompositionChild(parent.id, 'person', 'child-person', actor),
      compositions.attachCompositionChild(parent.id, 'diagnosis', 'child-diagnosis', actor),
    ]);

    const finalSession = await compositions.getCompositionSession(parent.id, actor);
    assert.equal(finalSession.childSessions.person, 'child-person', 'the person block attachment must survive');
    assert.equal(finalSession.childSessions.diagnosis, 'child-diagnosis', 'the diagnosis block attachment must survive');
    assert.equal(finalSession.progress.started, 2);
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
