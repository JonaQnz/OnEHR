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
  const clone = (value) => ({ ...value, childSessions: { ...value.childSessions }, childSessionGroups: { ...value.childSessionGroups } });

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

// The block's own formId ('person-form') is a snapshot from whenever the
// Composition was authored - a Form Section republish
// (create_form_draft/publish_form) archives that exact row and mints a new
// one under the same parent_id, so a freshly-launched child session
// legitimately carries that NEW id, not the block's original one. Without
// lineage-aware matching here, attaching such a child fails with "does not
// match this composition context" on every Composition embedding a Form
// Section that's ever been republished. Confirmed live (2026-09-02)
// against "Patientenstammdaten"/"Person (Basis)".
test('a child session bound to a republished sibling of the block\'s Form Section still attaches successfully', async () => {
  const store = installStore();
  const originalFormFindUnique = prisma.form.findUnique;
  prisma.form.findUnique = async ({ where }) => {
    if (where.id === 'person-form-v2') return { id: 'person-form-v2', parent_id: 'person-form', status: 'published' };
    return originalFormFindUnique({ where });
  };
  try {
    const parent = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada' }, actor);
    store.childRows.set('child-1', { id: 'child-1', formId: 'person-form-v2', status: 'draft', validation: [] });
    const attached = await compositions.attachCompositionChild(parent.id, 'person', 'child-1', actor);
    assert.equal(attached.status, 'in_progress');
    assert.equal(attached.childSessions.person, 'child-1');
  } finally { prisma.form.findUnique = originalFormFindUnique; store.restore(); }
});

const manualAddBlocks = [{ id: 'diagnosis', type: 'form', formId: 'diagnosis-form', title: 'Diagnose', manualAdd: true }];
const requiredManualAddBlocks = [{ id: 'diagnosis', type: 'form', formId: 'diagnosis-form', title: 'Diagnose', manualAdd: true, requireAtLeastOne: true }];

test('a manualAdd block with zero instances is optional by default - not counted in progress', async () => {
  const store = installStore({ blocks: manualAddBlocks });
  try {
    const parent = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada' }, actor);
    assert.equal(parent.children.length, 0, 'an untouched, non-required manualAdd block contributes no children');
    assert.equal(parent.progress.total, 0);
  } finally { store.restore(); }
});

test('a manualAdd block with requireAtLeastOne shows one outstanding not_started entry until an instance is added', async () => {
  const store = installStore({ blocks: requiredManualAddBlocks });
  try {
    const parent = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada' }, actor);
    assert.equal(parent.children.length, 1);
    assert.equal(parent.children[0].status, 'not_started');
    assert.equal(parent.children[0].sessionId, undefined);
    assert.equal(parent.progress.total, 1);
  } finally { store.restore(); }
});

test('a plain (non-instance) attach against a manualAdd block is rejected', async () => {
  const store = installStore({ blocks: manualAddBlocks });
  try {
    const parent = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada' }, actor);
    store.childRows.set('diag-1', { id: 'diag-1', formId: 'diagnosis-form', status: 'draft', validation: [] });
    await assert.rejects(
      compositions.attachCompositionChild(parent.id, 'diagnosis', 'diag-1', actor),
      /requires asNewInstance/i,
    );
  } finally { store.restore(); }
});

test('asNewInstance against a non-manualAdd block is rejected', async () => {
  const store = installStore();
  try {
    const parent = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada' }, actor);
    store.childRows.set('child-1', { id: 'child-1', formId: 'person-form', status: 'draft', validation: [] });
    await assert.rejects(
      compositions.attachCompositionChild(parent.id, 'person', 'child-1', actor, { asNewInstance: true }),
      /does not allow multiple instances/i,
    );
  } finally { store.restore(); }
});

test('clicking "+" repeatedly adds several independent instances of the same manualAdd block', async () => {
  const store = installStore({ blocks: manualAddBlocks });
  try {
    const parent = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada' }, actor);
    store.childRows.set('diag-1', { id: 'diag-1', formId: 'diagnosis-form', status: 'draft', validation: [] });
    store.childRows.set('diag-2', { id: 'diag-2', formId: 'diagnosis-form', status: 'draft', validation: [] });
    store.childRows.set('diag-3', { id: 'diag-3', formId: 'diagnosis-form', status: 'draft', validation: [] });

    let session = await compositions.attachCompositionChild(parent.id, 'diagnosis', 'diag-1', actor, { asNewInstance: true });
    session = await compositions.attachCompositionChild(parent.id, 'diagnosis', 'diag-2', actor, { asNewInstance: true });
    session = await compositions.attachCompositionChild(parent.id, 'diagnosis', 'diag-3', actor, { asNewInstance: true });

    assert.deepEqual(session.childSessionGroups.diagnosis, ['diag-1', 'diag-2', 'diag-3']);
    assert.equal(session.children.length, 3);
    assert.equal(session.progress.total, 3);
    assert.equal(session.progress.started, 3);
    assert.ok(session.children.every((child) => child.manualAdd === true));
    assert.deepEqual(session.children.map((child) => child.instanceIndex), [1, 2, 3]);

    // re-attaching an already-present session id is a no-op, not a duplicate
    const noop = await compositions.attachCompositionChild(parent.id, 'diagnosis', 'diag-1', actor, { asNewInstance: true });
    assert.deepEqual(noop.childSessionGroups.diagnosis, ['diag-1', 'diag-2', 'diag-3']);
  } finally { store.restore(); }
});

test('removing a draft manualAdd instance detaches it without touching the others', async () => {
  const store = installStore({ blocks: manualAddBlocks });
  try {
    const parent = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada' }, actor);
    store.childRows.set('diag-1', { id: 'diag-1', formId: 'diagnosis-form', status: 'draft', validation: [] });
    store.childRows.set('diag-2', { id: 'diag-2', formId: 'diagnosis-form', status: 'draft', validation: [] });
    await compositions.attachCompositionChild(parent.id, 'diagnosis', 'diag-1', actor, { asNewInstance: true });
    await compositions.attachCompositionChild(parent.id, 'diagnosis', 'diag-2', actor, { asNewInstance: true });

    const after = await compositions.removeCompositionInstance(parent.id, 'diagnosis', 'diag-1', actor);
    assert.deepEqual(after.childSessionGroups.diagnosis, ['diag-2']);
    assert.equal(after.children.length, 1);
  } finally { store.restore(); }
});

test('an already-submitted manualAdd instance cannot be removed', async () => {
  const store = installStore({ blocks: manualAddBlocks });
  try {
    const parent = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada' }, actor);
    store.childRows.set('diag-1', { id: 'diag-1', formId: 'diagnosis-form', status: 'draft', validation: [] });
    await compositions.attachCompositionChild(parent.id, 'diagnosis', 'diag-1', actor, { asNewInstance: true });
    store.childRows.set('diag-1', { ...store.childRows.get('diag-1'), status: 'submitted' });

    await assert.rejects(
      compositions.removeCompositionInstance(parent.id, 'diagnosis', 'diag-1', actor),
      /cannot|können nicht entfernt/i,
    );
  } finally { store.restore(); }
});

test('removeCompositionInstance rejects a block that is not manualAdd', async () => {
  const store = installStore();
  try {
    const parent = await compositions.startCompositionSession({ compositionFormId: 'composition-form', patientId: 'local-ada' }, actor);
    await assert.rejects(
      compositions.removeCompositionInstance(parent.id, 'person', 'child-1', actor),
      /does not allow multiple instances/i,
    );
  } finally { store.restore(); }
});
