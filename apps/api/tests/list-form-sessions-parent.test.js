const assert = require('node:assert/strict');
const test = require('node:test');

// "Aus vorheriger Dokumentation übernehmen" (LiveForm.tsx) needs to find a
// patient's prior submitted entries of a Form Section across every
// published version of it, not just the exact version currently loaded -
// republishing mints a new Form.id every time, so filtering by formId alone
// silently hides everything submitted under an older version. formId still
// matches only the exact version (unchanged, existing behavior); the new
// parentFormId resolves the whole parent_id lineage first.
const prisma = require('../dist/db/prisma').default;
const patients = require('../dist/services/patientService');
const formSessions = require('../dist/services/formSessionService');

const actor = { userId: 'clinician-1', authMode: 'local' };
const original = {
  formFindMany: prisma.form.findMany,
  formSessionFindMany: prisma.formSession.findMany,
  resolvePatientReference: patients.resolvePatientReference,
};

function installStore() {
  const forms = [
    { id: 'diagnosis-v1', parent_id: 'diagnosis-lineage' },
    { id: 'diagnosis-v2', parent_id: 'diagnosis-lineage' },
    { id: 'unrelated-form', parent_id: 'unrelated-lineage' },
  ];
  const sessions = [
    { id: 'session-old', formId: 'diagnosis-v1', formVersion: '1.0.0', mode: 'create', patientId: 'patient-1', userId: 'clinician-1', authMode: 'local', status: 'submitted', values: { note: 'old version' }, validation: [], revision: 1, createdAt: new Date('2026-08-01T10:00:00.000Z'), updatedAt: new Date('2026-08-01T10:00:00.000Z') },
    { id: 'session-new', formId: 'diagnosis-v2', formVersion: '2.0.0', mode: 'create', patientId: 'patient-1', userId: 'clinician-1', authMode: 'local', status: 'submitted', values: { note: 'new version' }, validation: [], revision: 1, createdAt: new Date('2026-08-20T10:00:00.000Z'), updatedAt: new Date('2026-08-20T10:00:00.000Z') },
    { id: 'session-unrelated', formId: 'unrelated-form', formVersion: '1.0.0', mode: 'create', patientId: 'patient-1', userId: 'clinician-1', authMode: 'local', status: 'submitted', values: {}, validation: [], revision: 1, createdAt: new Date('2026-08-20T10:00:00.000Z'), updatedAt: new Date('2026-08-20T10:00:00.000Z') },
  ];
  prisma.form.findMany = async ({ where }) => forms.filter((form) => form.parent_id === where.parent_id).map((form) => ({ id: form.id }));
  prisma.formSession.findMany = async ({ where }) => {
    const formMatch = where.formId?.in ? (row) => where.formId.in.includes(row.formId) : where.formId ? (row) => row.formId === where.formId : () => true;
    return sessions.filter((row) => row.patientId === where.patientId && row.userId === where.userId && formMatch(row));
  };
  patients.resolvePatientReference = async (patientId, namespace) => ({ patientId, patientNamespace: namespace, ehrId: `ehr-${patientId}`, origin: 'native' });
  return {
    restore: () => {
      prisma.form.findMany = original.formFindMany;
      prisma.formSession.findMany = original.formSessionFindMany;
      patients.resolvePatientReference = original.resolvePatientReference;
    },
  };
}

test('parentFormId finds a prior entry submitted under an older published version', async () => {
  const store = installStore();
  try {
    const results = await formSessions.listFormSessions(actor, 'patient-1', undefined, 'diagnosis-lineage');
    assert.deepEqual(results.map((row) => row.id).sort(), ['session-new', 'session-old']);
  } finally { store.restore(); }
});

test('plain formId still matches only the exact version, unchanged', async () => {
  const store = installStore();
  try {
    const results = await formSessions.listFormSessions(actor, 'patient-1', 'diagnosis-v1');
    assert.deepEqual(results.map((row) => row.id), ['session-old']);
  } finally { store.restore(); }
});

test('parentFormId never pulls in an unrelated lineage\'s sessions', async () => {
  const store = installStore();
  try {
    const results = await formSessions.listFormSessions(actor, 'patient-1', undefined, 'diagnosis-lineage');
    assert.ok(!results.some((row) => row.id === 'session-unrelated'));
  } finally { store.restore(); }
});
