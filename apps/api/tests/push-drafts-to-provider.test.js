const assert = require('node:assert/strict');
const test = require('node:test');

// Per-form settings.runtime.pushDraftsToProvider + the global
// pushDraftsToProviderByDefault (Configurable Settings roadmap, P1):
// autosaveFormSessionDraft's decision whether a draft save (debounced
// autosave or the manual "Entwurf speichern" button - both call this same
// action) also pushes to the session's data provider, or stays purely
// local until final submit.
const prisma = require('../dist/db/prisma').default;
const patients = require('../dist/services/patientService');
const compositionRepo = require('../dist/services/compositionRepository');
const configService = require('../dist/services/configService');
const formSessions = require('../dist/services/formSessionService');

const actor = { userId: 'clinician-1', authMode: 'local' };

const original = {
  formFindUnique: prisma.form.findUnique,
  formSessionFindUnique: prisma.formSession.findUnique,
  formSessionUpdate: prisma.formSession.update,
  resolvePatientReference: patients.resolvePatientReference,
  getCompositionRepository: compositionRepo.getCompositionRepository,
  getConfig: configService.getConfig,
};

function form(pushDraftsToProvider) {
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
      ...(pushDraftsToProvider !== undefined ? { settings: { runtime: { pushDraftsToProvider } } } : {}),
    },
  };
}

function installStore({ formPushSetting, pushDraftsToProviderByDefault } = {}) {
  const now = () => new Date('2026-08-27T10:00:00.000Z');
  let session = {
    id: 'session-1', formId: 'vitals-form', formVersion: '1.0.0', mode: 'create', status: 'draft',
    patientId: 'patient-1', patientNamespace: null, userId: actor.userId, authMode: actor.authMode,
    values: {}, validation: [], revision: 0, providerId: null, providerReference: null, draftReference: null,
    lifecycleState: 'new', lifecycleConfirmed: false, createdAt: now(), updatedAt: now(),
  };
  let commitCalls = 0;

  prisma.form.findUnique = async ({ where }) => (where.id === 'vitals-form' ? form(formPushSetting) : null);
  prisma.formSession.findUnique = async () => ({ ...session });
  prisma.formSession.update = async ({ data }) => {
    session = { ...session, ...data, updatedAt: now() };
    return { ...session };
  };
  patients.resolvePatientReference = async (patientId, namespace) => ({ patientId, patientNamespace: namespace, ehrId: `ehr-${patientId}`, origin: 'native' });
  compositionRepo.getCompositionRepository = () => ({
    commit: async ({ values }) => {
      commitCalls += 1;
      return { providerId: 'ehrbase', reference: 'composition-1::1', lifecycleState: 'incomplete', lifecycleConfirmed: true, values, metadata: {} };
    },
  });
  configService.getConfig = () => ({ ...(pushDraftsToProviderByDefault !== undefined ? { pushDraftsToProviderByDefault } : {}) });

  return {
    getSession: () => session,
    getCommitCalls: () => commitCalls,
    restore: () => {
      prisma.form.findUnique = original.formFindUnique;
      prisma.formSession.findUnique = original.formSessionFindUnique;
      prisma.formSession.update = original.formSessionUpdate;
      patients.resolvePatientReference = original.resolvePatientReference;
      compositionRepo.getCompositionRepository = original.getCompositionRepository;
      configService.getConfig = original.getConfig;
    },
  };
}

test('a draft save pushes to the provider by default (unchanged behavior)', async () => {
  const store = installStore();
  try {
    await formSessions.autosaveFormSessionDraft('session-1', 'ehrbase', actor, { note: 'hello' });
    assert.equal(store.getCommitCalls(), 1);
    assert.equal(store.getSession().draftReference, 'composition-1::1');
  } finally { store.restore(); }
});

test('a form\'s own pushDraftsToProvider: false keeps the draft local-only, but still saves it locally', async () => {
  const store = installStore({ formPushSetting: false });
  try {
    const result = await formSessions.autosaveFormSessionDraft('session-1', 'ehrbase', actor, { note: 'hello' });
    assert.equal(store.getCommitCalls(), 0, 'provider must never be pushed to when the form opts out');
    assert.equal(store.getSession().draftReference, null, 'no provider reference should appear without a provider push');
    assert.deepEqual(result.values, { note: 'hello' }, 'the local DB save must still happen regardless of the provider setting');
  } finally { store.restore(); }
});

test('the global pushDraftsToProviderByDefault: false applies when a form sets nothing of its own', async () => {
  const store = installStore({ pushDraftsToProviderByDefault: false });
  try {
    await formSessions.autosaveFormSessionDraft('session-1', 'ehrbase', actor, { note: 'hello' });
    assert.equal(store.getCommitCalls(), 0);
  } finally { store.restore(); }
});

test('an explicit per-form pushDraftsToProvider: true overrides a global default of false', async () => {
  const store = installStore({ formPushSetting: true, pushDraftsToProviderByDefault: false });
  try {
    await formSessions.autosaveFormSessionDraft('session-1', 'ehrbase', actor, { note: 'hello' });
    assert.equal(store.getCommitCalls(), 1);
  } finally { store.restore(); }
});
