const assert = require('node:assert/strict');
const test = require('node:test');

// The CDR-side half of the Form Session lifecycle (P2, formSessionCdrWriter):
// pushing a draft, committing a submission and withdrawing a composition used
// to live inline in formSessionService. These tests pin the rules that only
// ever mattered at the provider boundary - which reference a draft seeds from,
// and which provider failures are surfaced vs. swallowed.
const prisma = require('../dist/db/prisma').default;
const compositionRepo = require('../dist/services/compositionRepository');
const writer = require('../dist/services/formSessionCdrWriter');
const { EhrbaseProviderError } = require('../dist/services/ehrbaseDataProvider');
const { HttpError } = require('../dist/middleware/errorHandler');

const original = {
  formSessionUpdate: prisma.formSession.update,
  getCompositionRepository: compositionRepo.getCompositionRepository,
};

function installStore({ commitError, withRepository = true } = {}) {
  const updates = [];
  const commits = [];
  let session = {
    id: 'session-1', formId: 'vitals-form', formVersion: '1.0.0', mode: 'create', status: 'draft',
    patientId: 'patient-1', patientNamespace: null, userId: 'clinician-1', authMode: 'local',
    values: {}, validation: [], revision: 0, providerId: null, providerReference: null, draftReference: null,
    lifecycleState: 'new', lifecycleConfirmed: false,
    createdAt: new Date('2026-08-27T10:00:00.000Z'), updatedAt: new Date('2026-08-27T10:00:00.000Z'),
  };

  prisma.formSession.update = async ({ where, data }) => {
    updates.push({ where, data });
    session = { ...session, ...data, updatedAt: new Date() };
    return { ...session };
  };
  compositionRepo.getCompositionRepository = withRepository
    ? () => ({
      commit: async (input) => {
        commits.push(input);
        if (commitError) throw commitError;
        return {
          providerId: 'ehrbase',
          reference: 'composition-1::1',
          lifecycleState: 'incomplete',
          lifecycleConfirmed: true,
          values: input.values,
          metadata: {},
        };
      },
    })
    : () => undefined;

  return {
    getSession: () => session,
    getUpdates: () => updates,
    getCommits: () => commits,
    restore: () => {
      prisma.formSession.update = original.formSessionUpdate;
      compositionRepo.getCompositionRepository = original.getCompositionRepository;
    },
  };
}

const provider = {
  id: 'ehrbase',
  label: 'EHRbase',
  capabilities: ['draft', 'submit'],
  draft: async () => { throw new Error('provider.draft must not be used when a repository exists'); },
  submit: async () => { throw new Error('provider.submit must not be used when a repository exists'); },
  load: async () => ({}),
};

function draftArgs(overrides = {}) {
  return {
    sessionId: 'session-1',
    mode: 'create',
    draftReference: null,
    providerReference: null,
    providerId: 'ehrbase',
    context: { mode: 'create', patientId: 'patient-1', ehrId: 'ehr-patient-1', sessionId: 'session-1', userId: 'clinician-1', authMode: 'local' },
    form: { id: 'vitals-form', version: '1.0.0', definition: { id: 'vitals-form' } },
    provider,
    values: { note: 'hello' },
    ...overrides,
  };
}

test('edit mode with no draft yet seeds the provider push from providerReference', async () => {
  const store = installStore();
  try {
    const result = await writer.pushDraftToProvider(draftArgs({
      mode: 'edit',
      providerReference: 'ehr-1/composition/comp-9::1',
    }));
    assert.equal(store.getCommits().length, 1);
    assert.equal(store.getCommits()[0].reference, 'ehr-1/composition/comp-9::1');
    assert.equal(store.getCommits()[0].desiredLifecycleState, 'incomplete');
    assert.equal(store.getSession().draftReference, 'composition-1::1');
    assert.equal(store.getSession().lifecycleState, 'incomplete');
    assert.ok(result.updated, 'the updated session row is returned');
  } finally { store.restore(); }
});

test('create mode never seeds from providerReference, an existing draft is continued instead', async () => {
  const store = installStore();
  try {
    await writer.pushDraftToProvider(draftArgs({ mode: 'create', providerReference: 'ehr-1/composition/prefill-source::1' }));
    assert.equal(store.getCommits().length, 1);
    assert.equal('reference' in store.getCommits()[0], false, 'a prefill source must never be overwritten');

    await writer.pushDraftToProvider(draftArgs({ mode: 'create', draftReference: 'composition-7::2' }));
    assert.equal(store.getCommits()[1].reference, 'composition-7::2', 'the session\'s own draft is continued');
  } finally { store.restore(); }
});

test('a COMPOSITION_VERSION_CONFLICT is rethrown as HttpError 412, not swallowed', async () => {
  const store = installStore({ commitError: new EhrbaseProviderError('The composition changed since it was loaded. Reload the form before saving.', 'COMPOSITION_VERSION_CONFLICT', 412) });
  try {
    await assert.rejects(
      () => writer.pushDraftToProvider(draftArgs({ mode: 'edit', providerReference: 'comp-9::1' })),
      (error) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 412);
        return true;
      },
    );
    assert.equal(store.getUpdates().length, 0, 'a conflict must not write a provider reference');
  } finally { store.restore(); }
});

test('any other provider error (e.g. a 503) is swallowed and leaves draftReference untouched', async () => {
  const store = installStore({ commitError: new EhrbaseProviderError('CDR unavailable', 'EHRBASE_REQUEST_FAILED', 503) });
  try {
    const result = await writer.pushDraftToProvider(draftArgs({ mode: 'edit', providerReference: 'comp-9::1' }));
    assert.equal(result.updated, undefined);
    assert.equal(store.getUpdates().length, 0, 'the local draft stays as it was');
    assert.equal(store.getSession().draftReference, null);
  } finally { store.restore(); }
});

test('withdrawComposition rejects an unknown provider with 501', async () => {
  const store = installStore({ withRepository: false });
  try {
    await assert.rejects(
      () => writer.withdrawComposition({ providerId: 'n8n', context: draftArgs().context, reference: 'comp-9::1' }),
      (error) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 501);
        return true;
      },
    );
  } finally { store.restore(); }
});
