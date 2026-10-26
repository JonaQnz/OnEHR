const assert = require('node:assert/strict');
const test = require('node:test');
const axiosModule = require('axios');
const axios = axiosModule.default || axiosModule;
const configService = require('../dist/services/configService');
const { updateFhirResource } = require('../dist/services/fhirCdrService');

// updateFhirResource (PUT /{resourceType}/{id}) - added alongside the
// pre-existing createFhirResource/getFhirResource/searchFhirResource so a
// FHIR Resource Form can genuinely edit a resource in place (id-preserving)
// rather than only ever creating new ones. Mirrors createFhirResource's own
// test-mocking convention (monkey-patch axios + configService, restore in
// finally) - no dedicated test file existed for this service before.
function withNoneAuthConnection(fn) {
  const original = configService.getActiveEhrbaseConnection;
  configService.getActiveEhrbaseConnection = () => ({
    id: 'test-connection', name: 'Test', url: 'https://ehrbase.example', authPlugin: 'none',
  });
  return fn().finally(() => { configService.getActiveEhrbaseConnection = original; });
}

test('updateFhirResource PUTs to /{resourceType}/{id} with the given body and returns the server response', async () => {
  await withNoneAuthConnection(async () => {
    const originalPut = axios.put;
    const calls = [];
    axios.put = async (url, body, config) => {
      calls.push({ url, body, config });
      return { data: { resourceType: 'Appointment', id: 'appt-1', status: 'booked', meta: { versionId: '2' } }, status: 200 };
    };
    try {
      const result = await updateFhirResource('Appointment', 'appt-1', { resourceType: 'Appointment', id: 'appt-1', status: 'booked' });
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/fhir\/R4\/Appointment\/appt-1$/);
      assert.deepEqual(calls[0].body, { resourceType: 'Appointment', id: 'appt-1', status: 'booked' });
      assert.equal(result.meta.versionId, '2');
    } finally {
      axios.put = originalPut;
    }
  });
});

test('updateFhirResource surfaces the FHIR OperationOutcome diagnostics on failure', async () => {
  await withNoneAuthConnection(async () => {
    const originalPut = axios.put;
    axios.put = async () => {
      const error = new Error('Request failed');
      error.response = { status: 422, data: { issue: [{ diagnostics: 'id mismatch' }] } };
      throw error;
    };
    try {
      await assert.rejects(
        () => updateFhirResource('Appointment', 'appt-1', { resourceType: 'Appointment', id: 'appt-1' }),
        /id mismatch/,
      );
    } finally {
      axios.put = originalPut;
    }
  });
});
