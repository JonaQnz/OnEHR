const assert = require('node:assert/strict');
const test = require('node:test');

// launchForm's formId is frequently a lineage anchor rather than "the
// record that's published right now": a Composition block's own formId is
// whatever specific version was published at the time the block was
// configured, and that exact row becomes an archived sibling (status
// flips, a new row id is minted) the instant anyone publishes a newer
// version under the same parent_id (create_form_draft/publish_form).
// Without resolving to the latest published sibling, EVERY Composition
// embedding that Form Section broke on its next fresh launch the moment
// the Form Section's author published a content fix - confirmed live
// (2026-09-02) against "Patientenstammdaten"/"Person (Basis)".
const prisma = require('../dist/db/prisma').default;
const patients = require('../dist/services/patientService');
const aql = require('../dist/services/aqlFunctionService');
const launch = require('../dist/services/formLaunchService');

const actor = { userId: 'clinician-1', authMode: 'local' };

const original = {
  formFindUnique: prisma.form.findUnique,
  formFindFirst: prisma.form.findFirst,
  formSessionCreate: prisma.formSession.create,
  formSessionUpdate: prisma.formSession.update,
  resolvePatientReference: patients.resolvePatientReference,
  buildSessionRuntimeContext: aql.buildSessionRuntimeContext,
};

// A standalone Composition (extensions["watehr.composition"] present), not
// a bare Form Section - launchForm's resolution fix is agnostic to which,
// but a standalone Composition sidesteps assertFormSectionLaunchAllowed's
// separate compositionContext requirement, keeping this test focused on
// just the published-sibling resolution being exercised.
function formRow({ id, parentId, status, createdAt }) {
  return {
    id, parent_id: parentId, version: '1.0.0', status, createdAt,
    canonical_json: {
      id, name: 'Patientenstammdaten', version: '1.0.0', sourceTemplates: [],
      layout: { type: 'form', children: [{ type: 'container', children: [] }] }, bindings: {}, locales: {},
      extensions: { 'watehr.composition': { schemaVersion: '1.0', pages: [] } },
    },
  };
}

function installStore(forms) {
  const formSessionRecords = new Map();
  let formSessionSequence = 0;
  const now = () => new Date('2026-09-02T07:00:00.000Z');

  prisma.form.findUnique = async ({ where }) => forms.find((f) => f.id === where.id) || null;
  prisma.form.findFirst = async ({ where }) => {
    const candidates = forms.filter((f) => f.parent_id === where.parent_id && f.status === where.status);
    candidates.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return candidates[0] || null;
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
      prisma.form.findFirst = original.formFindFirst;
      prisma.formSession.create = original.formSessionCreate;
      prisma.formSession.update = original.formSessionUpdate;
      patients.resolvePatientReference = original.resolvePatientReference;
      aql.buildSessionRuntimeContext = original.buildSessionRuntimeContext;
    },
  };
}

test('launching an archived formId resolves to the latest published sibling under the same parent_id', async () => {
  const forms = [
    formRow({ id: 'person-v1', parentId: 'person-v1', status: 'archived', createdAt: new Date('2026-08-31T19:13:01.000Z') }),
    formRow({ id: 'person-v1-1', parentId: 'person-v1', status: 'published', createdAt: new Date('2026-09-02T07:03:32.000Z') }),
  ];
  const store = installStore(forms);
  try {
    const result = await launch.launchForm({ formId: 'person-v1', patient: { id: 'patient-1' }, mode: 'create' }, actor);
    assert.equal(result.session.formId, 'person-v1-1');
  } finally { store.restore(); }
});

test('launching an already-published formId is unaffected - resolves to itself, not some other sibling', async () => {
  const forms = [
    formRow({ id: 'person-v1-1', parentId: 'person-v1', status: 'published', createdAt: new Date('2026-09-02T07:03:32.000Z') }),
  ];
  const store = installStore(forms);
  try {
    const result = await launch.launchForm({ formId: 'person-v1-1', patient: { id: 'patient-1' }, mode: 'create' }, actor);
    assert.equal(result.session.formId, 'person-v1-1');
  } finally { store.restore(); }
});

test('launching an archived formId with no published sibling anywhere in its lineage still fails clearly', async () => {
  const forms = [
    formRow({ id: 'person-v1', parentId: 'person-v1', status: 'archived', createdAt: new Date('2026-08-31T19:13:01.000Z') }),
  ];
  const store = installStore(forms);
  try {
    await assert.rejects(
      launch.launchForm({ formId: 'person-v1', patient: { id: 'patient-1' }, mode: 'create' }, actor),
      (err) => { assert.equal(err.status, 409); assert.match(err.message, /Only published forms/i); return true; },
    );
  } finally { store.restore(); }
});

test('resolution picks the MOST RECENT published sibling when several exist (e.g. an old republish left more than one)', async () => {
  const forms = [
    formRow({ id: 'person-v1', parentId: 'person-v1', status: 'archived', createdAt: new Date('2026-08-31T19:13:01.000Z') }),
    formRow({ id: 'person-v1-1-stale', parentId: 'person-v1', status: 'archived', createdAt: new Date('2026-09-01T00:00:00.000Z') }),
    formRow({ id: 'person-v1-2', parentId: 'person-v1', status: 'published', createdAt: new Date('2026-09-02T07:03:32.000Z') }),
  ];
  const store = installStore(forms);
  try {
    const result = await launch.launchForm({ formId: 'person-v1', patient: { id: 'patient-1' }, mode: 'create' }, actor);
    assert.equal(result.session.formId, 'person-v1-2');
  } finally { store.restore(); }
});
