const assert = require('node:assert/strict');
const test = require('node:test');
const {
  EhrbaseDataProvider,
  EhrbaseProviderError,
} = require('../dist/services/ehrbaseDataProvider');
const {
  fromOpenEhrFlatComposition,
  toOpenEhrFlatComposition,
} = require('openehr-engine');

function definition() {
  return {
    id: 'vitals-form',
    name: 'Vitals',
    version: '1.0.0',
    sourceTemplates: [{ alias: 'vitals', id: 'vitals.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    layout: { type: 'form', children: [] },
    locales: { en: {} },
    bindings: {
      name: { openehr: { flatPath: 'vitals/name', rmType: 'DV_TEXT' } },
      weight: { openehr: { flatPath: 'vitals/weight', rmType: 'DV_QUANTITY' } },
      status: { openehr: { flatPath: 'vitals/status', rmType: 'DV_CODED_TEXT' } },
      active: { openehr: { flatPath: 'vitals/active', rmType: 'DV_BOOLEAN' } },
    },
  };
}

test('uses the transport-independent openEHR mapping implementation', () => {
  const values = { name: 'Ada', weight: { magnitude: 63, unit: 'kg' }, status: 'ok', active: true };
  const flat = toOpenEhrFlatComposition(definition(), values, { composerName: 'alice', time: '2026-01-01T00:00:00.000Z' });
  assert.equal(flat['vitals/name'], 'Ada');
  assert.equal(flat['vitals/weight|magnitude'], 63);
  assert.equal(flat['vitals/weight|unit'], 'kg');
  assert.equal(flat['vitals/status|code'], 'ok');
  assert.equal(flat['vitals/active'], true);
  assert.equal(flat['ctx/composer_name'], 'alice');
  assert.equal(flat['ctx/template_id'], 'vitals.v1');

  assert.deepEqual(fromOpenEhrFlatComposition(definition(), flat), values);
});

test('edit loads the template composition and creates a new version with PUT', async () => {
  const calls = [];
  const versionOne = '11111111-1111-1111-1111-111111111111::vitals.v1::1';
  const versionTwo = '11111111-1111-1111-1111-111111111111::vitals.v1::2';
  const http = {
    async get(url, options) {
      calls.push({ method: 'GET', url, options });
      if (url.endsWith('/ehr')) return { data: { ehr_id: { value: 'ehr-1' } } };
      return { data: [{ 'vitals/name': 'Ada' }] };
    },
    async post(url, body, options) {
      calls.push({ method: 'POST', url, body, options });
      if (url.endsWith('/query/aql')) return { data: { rows: [[versionOne]] } };
      throw new Error(`unexpected POST ${url}`);
    },
    async put(url, body, options) {
      calls.push({ method: 'PUT', url, body, options });
      return { data: {}, headers: { location: `/ehr/ehr-1/composition/${versionTwo}` } };
    },
  };
  const provider = new EhrbaseDataProvider({
    http,
    config: { ehrbaseUrl: 'http://ehrbase/rest/openehr/v1', ehrbaseUser: 'admin', ehrbasePass: 'secret', authMode: 'basic', ehrbaseSubjectNamespace: 'demo' },
  });
  const input = { context: { patientId: 'patient-1', patientNamespace: 'demo', userId: 'alice', mode: 'edit' }, form: { id: 'form-1', version: '1.0.0', definition: definition() } };
  const loaded = await provider.load(input);
  assert.equal(loaded.values.name, 'Ada');
  assert.equal(loaded.reference, versionOne);
  assert.match(calls[1].url, /\/query\/aql$/);
  assert.match(calls[1].body.q, /vitals\.v1/);

  const submitted = await provider.submit({ ...input, reference: loaded.reference, values: { name: 'Grace' } });
  const update = calls.find((call) => call.method === 'PUT');
  assert.equal(submitted.reference, `/ehr/ehr-1/composition/${versionTwo}`);
  assert.match(update.url, /\/composition\/11111111-1111-1111-1111-111111111111$/);
  assert.equal(update.options.headers['If-Match'], versionOne);
  assert.equal(update.options.params.templateId, 'vitals.v1');
  assert.equal(update.body['vitals/name'], 'Grace');
  assert.equal(calls.filter((call) => call.method === 'POST' && /\/composition$/.test(call.url)).length, 0);
});

test('edit resolves a missing reference before updating and never creates a composition', async () => {
  const calls = [];
  const versionUid = '22222222-2222-2222-2222-222222222222::vitals.v1::3';
  const http = {
    async get(url, options) {
      calls.push({ method: 'GET', url, options });
      if (url.endsWith('/ehr')) return { data: { ehr_id: { value: 'ehr-1' } } };
      throw new Error(`unexpected GET ${url}`);
    },
    async post(url, body, options) {
      calls.push({ method: 'POST', url, body, options });
      if (url.endsWith('/query/aql')) return { data: { rows: [[versionUid]] } };
      throw new Error(`unexpected POST ${url}`);
    },
    async put(url, body, options) {
      calls.push({ method: 'PUT', url, body, options });
      return { data: {}, headers: { location: `/ehr/ehr-1/composition/${versionUid.replace(/::3$/, '::4')}` } };
    },
  };
  const provider = new EhrbaseDataProvider({ http, config: { ehrbaseUrl: 'http://ehrbase/rest/openehr/v1', ehrbaseUser: 'admin', ehrbasePass: 'secret', authMode: 'basic', ehrbaseSubjectNamespace: 'demo' } });

  await provider.submit({
    context: { patientId: 'patient-1', patientNamespace: 'demo', userId: 'alice', mode: 'edit' },
    form: { id: 'form-1', version: '1.0.0', definition: definition() },
    values: { name: 'Grace' },
  });

  assert.equal(calls.filter((call) => call.method === 'POST' && /\/query\/aql$/.test(call.url)).length, 1);
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 1);
  assert.equal(calls.filter((call) => call.method === 'POST' && /\/composition$/.test(call.url)).length, 0);
});

test('edit turns a stale version into a conflict instead of creating a second composition', async () => {
  const calls = [];
  const versionUid = '33333333-3333-3333-3333-333333333333::vitals.v1::1';
  const http = {
    async get(url) {
      calls.push({ method: 'GET', url });
      return { data: { ehr_id: { value: 'ehr-1' } } };
    },
    async post(url, body) {
      calls.push({ method: 'POST', url, body });
      if (url.endsWith('/query/aql')) return { data: { rows: [[versionUid]] } };
      throw new Error(`unexpected POST ${url}`);
    },
    async put(url) {
      calls.push({ method: 'PUT', url });
      const error = new Error('stale composition');
      error.response = { status: 412 };
      throw error;
    },
  };
  const provider = new EhrbaseDataProvider({ http, config: { ehrbaseUrl: 'http://ehrbase/rest/openehr/v1', ehrbaseUser: 'admin', ehrbasePass: 'secret', authMode: 'basic', ehrbaseSubjectNamespace: 'demo' } });

  await assert.rejects(
    provider.submit({ context: { patientId: 'patient-1', patientNamespace: 'demo', userId: 'alice', mode: 'edit' }, form: { id: 'form-1', version: '1.0.0', definition: definition() }, values: { name: 'Grace' } }),
    (error) => error instanceof EhrbaseProviderError && error.code === 'COMPOSITION_VERSION_CONFLICT' && error.status === 409,
  );
  assert.equal(calls.filter((call) => call.method === 'POST' && /\/composition$/.test(call.url)).length, 0);
});

test('create and prefill submit new compositions even when given an old reference', async () => {
  for (const mode of ['create', 'prefill']) {
    const calls = [];
    const http = {
      async get(url) {
        calls.push({ method: 'GET', url });
        return { data: { ehr_id: { value: 'ehr-1' } } };
      },
      async post(url, body, options) {
        calls.push({ method: 'POST', url, body, options });
        return { data: {}, headers: { location: '/ehr/ehr-1/composition/new-version' } };
      },
      async put() {
        throw new Error('PUT must not be used outside edit mode');
      },
    };
    const provider = new EhrbaseDataProvider({ http, config: { ehrbaseUrl: 'http://ehrbase/rest/openehr/v1', ehrbaseUser: 'admin', ehrbasePass: 'secret', authMode: 'basic', ehrbaseSubjectNamespace: 'demo' } });

    await provider.submit({ context: { patientId: 'patient-1', patientNamespace: 'demo', userId: 'alice', mode }, form: { id: 'form-1', version: '1.0.0', definition: definition() }, reference: '44444444-4444-4444-4444-444444444444::vitals.v1::1', values: { name: 'Grace' } });
    assert.equal(calls.filter((call) => call.method === 'POST' && /\/composition$/.test(call.url)).length, 1, `${mode} creates a composition`);
  }
});

test('draft creates on first write and updates the same composition on subsequent writes', async () => {
  const calls = [];
  const versionOne = '55555555-5555-5555-5555-555555555555::vitals.v1::1';
  const versionTwo = '55555555-5555-5555-5555-555555555555::vitals.v1::2';
  const http = {
    async get(url) {
      calls.push({ method: 'GET', url });
      return { data: { ehr_id: { value: 'ehr-1' } } };
    },
    async post(url, body, options) {
      calls.push({ method: 'POST', url, body, options });
      return { data: {}, headers: { location: `/ehr/ehr-1/composition/${versionOne}` } };
    },
    async put(url, body, options) {
      calls.push({ method: 'PUT', url, body, options });
      return { data: {}, headers: { location: `/ehr/ehr-1/composition/${versionTwo}` } };
    },
  };
  const provider = new EhrbaseDataProvider({ http, config: { ehrbaseUrl: 'http://ehrbase/rest/openehr/v1', ehrbaseUser: 'admin', ehrbasePass: 'secret', authMode: 'basic', ehrbaseSubjectNamespace: 'demo' } });
  const input = { context: { patientId: 'patient-1', patientNamespace: 'demo', userId: 'alice', mode: 'create' }, form: { id: 'form-1', version: '1.0.0', definition: definition() } };

  const first = await provider.draft({ ...input, values: { name: 'Ada' } });
  assert.equal(calls.filter((call) => call.method === 'POST' && /\/composition$/.test(call.url)).length, 1, 'first draft creates');
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0);
  assert.equal(first.reference, `/ehr/ehr-1/composition/${versionOne}`);

  const second = await provider.draft({ ...input, values: { name: 'Ada Grace' }, reference: first.reference });
  const update = calls.find((call) => call.method === 'PUT');
  assert.ok(update, 'second draft updates via PUT');
  assert.equal(second.reference, `/ehr/ehr-1/composition/${versionTwo}`);
  assert.equal(calls.filter((call) => call.method === 'POST' && /\/composition$/.test(call.url)).length, 1, 'still only one create');
});

test('submit reuses a session\'s own draft reference in create mode when continuesDraft is set', async () => {
  const calls = [];
  const versionOne = '66666666-6666-6666-6666-666666666666::vitals.v1::1';
  const versionTwo = '66666666-6666-6666-6666-666666666666::vitals.v1::2';
  const http = {
    async get(url) {
      calls.push({ method: 'GET', url });
      return { data: { ehr_id: { value: 'ehr-1' } } };
    },
    async post(url, body, options) {
      calls.push({ method: 'POST', url, body, options });
      throw new Error('unexpected POST - final submit should update the drafted composition, not create a new one');
    },
    async put(url, body, options) {
      calls.push({ method: 'PUT', url, body, options });
      return { data: {}, headers: { location: `/ehr/ehr-1/composition/${versionTwo}` } };
    },
  };
  const provider = new EhrbaseDataProvider({ http, config: { ehrbaseUrl: 'http://ehrbase/rest/openehr/v1', ehrbaseUser: 'admin', ehrbasePass: 'secret', authMode: 'basic', ehrbaseSubjectNamespace: 'demo' } });

  const submitted = await provider.submit({
    context: { patientId: 'patient-1', patientNamespace: 'demo', userId: 'alice', mode: 'create' },
    form: { id: 'form-1', version: '1.0.0', definition: definition() },
    values: { name: 'Grace' },
    reference: `/ehr/ehr-1/composition/${versionOne}`,
    continuesDraft: true,
  });
  assert.equal(submitted.reference, `/ehr/ehr-1/composition/${versionTwo}`);
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 1);
});

test('view mode cannot submit a composition', async () => {
  const provider = new EhrbaseDataProvider();
  await assert.rejects(
    provider.submit({ context: { patientId: 'patient-1', userId: 'alice', mode: 'view' }, form: { id: 'form-1', version: '1.0.0', definition: definition() }, values: {} }),
    (error) => error instanceof EhrbaseProviderError && error.code === 'FORM_MODE_READ_ONLY' && error.status === 403,
  );
});

test('prefers the trusted patient-registry EHR ID over subject lookup', async () => {
  const calls = [];
  const http = {
    async get(url, options) {
      calls.push({ method: 'GET', url, options });
      return { data: [] };
    },
    async post(url, body, options) {
      calls.push({ method: 'POST', url, body, options });
      return { data: { rows: [] } };
    },
  };
  const provider = new EhrbaseDataProvider({
    http,
    config: {
      ehrbaseUrl: 'http://ehrbase/rest/openehr/v1',
      ehrbaseUser: 'admin',
      ehrbasePass: 'secret',
      authMode: 'basic',
      defaultEhrId: 'wrong-default-ehr',
    },
  });

  const loaded = await provider.load({
    context: {
      patientId: 'asdas',
      patientNamespace: 'default',
      ehrId: '3bfb00d8-62f0-4fd5-abbc-a37c9cd4fc5a',
      userId: 'alice',
      mode: 'edit',
    },
    form: { id: 'form-1', version: '1.0.0', definition: definition() },
  });

  assert.equal(loaded.metadata.ehrId, '3bfb00d8-62f0-4fd5-abbc-a37c9cd4fc5a');
  assert.match(calls[0].url, /\/query\/aql$/);
  assert.match(calls[0].body.q, /3bfb00d8-62f0-4fd5-abbc-a37c9cd4fc5a/);
});

test('referenceFrom prefers the etag header (full versioned uid) over location (base uid only)', async () => {
  const calls = [];
  const versionUid = '77777777-7777-7777-7777-777777777777::vitals.v1::1';
  const http = {
    async get(url) {
      calls.push({ method: 'GET', url });
      return { data: { ehr_id: { value: 'ehr-1' } } };
    },
    async post(url, body, options) {
      calls.push({ method: 'POST', url, body, options });
      // EHRbase's real Location header only ever carries the base
      // (unversioned) uid on this CDR - confirmed live. etag carries the
      // full `{uid}::{system}::{version}` form, quoted.
      return { data: {}, headers: { location: '/ehr/ehr-1/composition/77777777-7777-7777-7777-777777777777', etag: `"${versionUid}"` } };
    },
  };
  const provider = new EhrbaseDataProvider({ http, config: { ehrbaseUrl: 'http://ehrbase/rest/openehr/v1', ehrbaseUser: 'admin', ehrbasePass: 'secret', authMode: 'basic', ehrbaseSubjectNamespace: 'demo' } });
  const result = await provider.submit({ context: { patientId: 'patient-1', patientNamespace: 'demo', userId: 'alice', mode: 'create' }, form: { id: 'form-1', version: '1.0.0', definition: definition() }, values: { name: 'Ada' } });
  assert.equal(result.reference, versionUid);
});

test('commitWithLifecycle attempts the audit headers, verifies via readback, and reports confirmation honestly', async () => {
  const calls = [];
  const versionUid = '88888888-8888-8888-8888-888888888888::vitals.v1::1';
  const http = {
    async get(url) {
      calls.push({ method: 'GET', url });
      if (url.endsWith('/ehr')) return { data: { ehr_id: { value: 'ehr-1' } } };
      // Readback of the committed version - this CDR (confirmed live)
      // silently ignores the requested lifecycle_state/change_type and
      // always reports its own defaults.
      if (url.includes('/versioned_composition/')) {
        return { data: { lifecycle_state: { value: 'complete' }, commit_audit: { change_type: { value: 'creation' } } } };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    async post(url, body, options) {
      calls.push({ method: 'POST', url, body, options });
      return { data: {}, headers: { etag: `"${versionUid}"` } };
    },
  };
  const provider = new EhrbaseDataProvider({ http, config: { ehrbaseUrl: 'http://ehrbase/rest/openehr/v1', ehrbaseUser: 'admin', ehrbasePass: 'secret', authMode: 'basic', ehrbaseSubjectNamespace: 'demo' } });
  const input = { context: { patientId: 'patient-1', patientNamespace: 'demo', userId: 'alice', mode: 'create' }, form: { id: 'form-1', version: '1.0.0', definition: definition() }, values: { name: 'Ada' }, desiredLifecycleState: 'incomplete' };

  const first = await provider.commitWithLifecycle(input, 'draft');
  assert.equal(first.lifecycleState, 'incomplete');
  assert.equal(first.lifecycleConfirmed, false, 'the CDR did not actually apply incomplete, so this must be false, not assumed true');
  const postCall = calls.find((call) => call.method === 'POST');
  assert.ok(postCall.options.headers['openEHR-AUDIT_DETAILS'], 'the real mechanism is attempted, not skipped, on the first call');
  assert.ok(postCall.options.headers['openEHR-VERSION']);
  const readbackCallsAfterFirst = calls.filter((call) => call.method === 'GET' && call.url.includes('/versioned_composition/')).length;
  assert.equal(readbackCallsAfterFirst, 1);

  // A second commit on the SAME connection should skip both the header
  // attempt and the pointless readback round-trip - the capability is now
  // known to be unsupported here.
  const second = await provider.commitWithLifecycle(input, 'draft');
  assert.equal(second.lifecycleConfirmed, false);
  const postCalls = calls.filter((call) => call.method === 'POST');
  assert.equal(postCalls[1].options.headers['openEHR-AUDIT_DETAILS'], undefined, 'a connection known to ignore the headers should not keep re-attempting them');
  const readbackCallsAfterSecond = calls.filter((call) => call.method === 'GET' && call.url.includes('/versioned_composition/')).length;
  assert.equal(readbackCallsAfterSecond, 1, 'no additional readback once the capability is cached as unsupported');
});

test('withdraw logically deletes via DELETE and never touches other HTTP verbs', async () => {
  const calls = [];
  const versionUid = '99999999-9999-9999-9999-999999999999::vitals.v1::1';
  const nextVersionUid = '99999999-9999-9999-9999-999999999999::vitals.v1::2';
  const http = {
    async get(url) {
      calls.push({ method: 'GET', url });
      return { data: { ehr_id: { value: 'ehr-1' } } };
    },
    async delete(url, options) {
      calls.push({ method: 'DELETE', url, options });
      return { data: {}, status: 204, headers: { etag: `"${nextVersionUid}"` } };
    },
  };
  const provider = new EhrbaseDataProvider({ http, config: { ehrbaseUrl: 'http://ehrbase/rest/openehr/v1', ehrbaseUser: 'admin', ehrbasePass: 'secret', authMode: 'basic', ehrbaseSubjectNamespace: 'demo' } });

  const result = await provider.withdraw({
    context: { patientId: 'patient-1', patientNamespace: 'demo', userId: 'alice', mode: 'edit' },
    reference: versionUid,
    reason: 'Falscher Patient dokumentiert',
  });
  assert.equal(result.versionUid, nextVersionUid);
  const del = calls.find((call) => call.method === 'DELETE');
  assert.match(del.url, new RegExp(`/composition/${encodeURIComponent(versionUid)}$`));
  assert.ok(del.options.headers['openEHR-AUDIT_DETAILS']);
});

test('withdraw turns a 412 into the same conflict error as a normal update', async () => {
  const http = {
    async get() { return { data: { ehr_id: { value: 'ehr-1' } } }; },
    async delete() {
      const error = new Error('stale composition');
      error.response = { status: 412 };
      throw error;
    },
  };
  const provider = new EhrbaseDataProvider({ http, config: { ehrbaseUrl: 'http://ehrbase/rest/openehr/v1', ehrbaseUser: 'admin', ehrbasePass: 'secret', authMode: 'basic', ehrbaseSubjectNamespace: 'demo' } });
  await assert.rejects(
    provider.withdraw({ context: { patientId: 'patient-1', userId: 'alice', mode: 'edit' }, reference: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa::vitals.v1::1' }),
    (error) => error instanceof EhrbaseProviderError && error.code === 'COMPOSITION_VERSION_CONFLICT' && error.status === 409,
  );
});

test('does not silently submit a known patient to the configured default EHR', async () => {
  const provider = new EhrbaseDataProvider({
    http: {
      async get() {
        const error = new Error('not found');
        error.response = { status: 404 };
        throw error;
      },
      async post() {
        throw new Error('not used');
      },
    },
    config: {
      ehrbaseUrl: 'http://ehrbase/rest/openehr/v1',
      ehrbaseUser: 'admin',
      ehrbasePass: 'secret',
      authMode: 'basic',
      defaultEhrId: 'default-ehr',
    },
  });

  await assert.rejects(
    provider.load({
      context: { patientId: 'missing-patient', userId: 'alice' },
      form: { id: 'form-1', version: '1.0.0', definition: definition() },
    }),
    (error) => error instanceof EhrbaseProviderError && error.code === 'PATIENT_EHR_NOT_FOUND',
  );
});
