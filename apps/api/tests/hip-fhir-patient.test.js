const assert = require('node:assert/strict');
const test = require('node:test');
const axiosModule = require('axios');
const axios = axiosModule.default || axiosModule;
const { buildIsikPatientResource, ehrbaseConnectionAuthPlugins } = require('../dist/services/ehrbaseConnectionPlugins');
const configService = require('../dist/services/configService');
const patientService = require('../dist/services/patientService');

function connection(overrides = {}) {
  return {
    id: `hip-fhir-test-${Math.random()}`,
    name: 'HIP Test',
    url: 'https://hip.example/ehrbase/rest/openehr/v1',
    authPlugin: 'hip-keycloak',
    username: 'service-user',
    password: 'service-password',
    keycloakBaseUrl: 'https://keycloak.example',
    keycloakRealm: 'tenant',
    keycloakClientId: 'HIP-CDR-Bridge-FHIR-Connector',
    keycloakGrantType: 'password',
    fhirBaseUrl: 'https://fhir.example',
    fhirPatientProfile: 'https://gematik.de/fhir/isik/StructureDefinition/ISiKPatient',
    fhirPatientMapping: {
      insuranceNumber: 'insuranceNumber', insuranceType: 'insuranceType',
      firstName: 'firstName', lastName: 'lastName', gender: 'gender', birthDate: 'birthDate',
      street: 'street', houseNumber: 'houseNumber', city: 'city', postalCode: 'postalCode', country: 'country',
    },
    ...overrides,
  };
}

const values = {
  insuranceNumber: 'N618425648', insuranceType: 'PKV',
  firstName: 'Günter', lastName: 'Krause', gender: 'male', birthDate: '1955-09-17',
  street: 'Kirchstraße', houseNumber: '20', city: 'Augsburg', postalCode: '86150', country: 'DE',
};

test('buildIsikPatientResource maps the configured Person form fields to the working ISiK Patient shape', () => {
  const result = buildIsikPatientResource(connection(), values);
  assert.equal(result.firstName, values.firstName);
  assert.deepEqual(result.resource.meta, { profile: ['https://gematik.de/fhir/isik/StructureDefinition/ISiKPatient'] });
  assert.deepEqual(result.resource.identifier, [
    {
      type: { coding: [{ system: 'http://fhir.de/CodeSystem/identifier-type-de-basis', code: 'PKV' }] },
      system: 'http://fhir.de/sid/pkv/kvid-10', value: 'N618425648',
    },
  ]);
  assert.deepEqual(result.resource.name, [{
    use: 'official', family: 'Krause',
    _family: { extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/humanname-own-name', valueString: 'Krause' }] },
    given: ['Günter'],
  }]);
  assert.deepEqual(result.resource.address, [{
    type: 'both', line: ['Kirchstraße 20'],
    _line: [{ extension: [
      { url: 'http://hl7.org/fhir/StructureDefinition/iso21090-ADXP-streetName', valueString: 'Kirchstraße' },
      { url: 'http://hl7.org/fhir/StructureDefinition/iso21090-ADXP-houseNumber', valueString: '20' },
    ] }],
    city: 'Augsburg', postalCode: '86150', country: 'DE',
  }]);
  assert.equal(result.resource.gender, 'male');
  assert.equal(result.resource.birthDate, '1955-09-17');
  assert.equal(result.resource.active, true);
});

test('patient creation uses EHRbase without HIP and fails closed for incomplete HIP FHIR settings', () => {
  const original = configService.getActiveEhrbaseConnection;
  try {
    configService.getActiveEhrbaseConnection = () => ({ id: 'basic', name: 'EHRbase', url: 'https://ehr.example', authPlugin: 'basic' });
    assert.deepEqual(patientService.getPatientCreationConfiguration(), { mode: 'ehrbase', configured: true });

    configService.getActiveEhrbaseConnection = () => ({ id: 'hip', name: 'HIP', url: 'https://ehr.example', authPlugin: 'hip-keycloak' });
    const incomplete = patientService.getPatientCreationConfiguration();
    assert.equal(incomplete.mode, 'fhir');
    assert.equal(incomplete.configured, false);
    assert.match(incomplete.error, /FHIR API.*Person-Formular.*Mapping Vorname/);

    configService.getActiveEhrbaseConnection = () => connection({ fhirPatientFormId: 'person-form-parent' });
    assert.deepEqual(patientService.getPatientCreationConfiguration(), { mode: 'fhir', configured: true, formId: 'person-form-parent' });
  } finally {
    configService.getActiveEhrbaseConnection = original;
  }
});

test('HIP createFhirPatient reuses the HIP Keycloak token and posts to /Patient', async () => {
  const originalPost = axios.post;
  const calls = [];
  axios.post = async (url, body, config) => {
    calls.push({ url, body, config });
    if (url.includes('/protocol/openid-connect/token')) return { data: { access_token: 'same-hip-token', expires_in: 300 }, headers: {} };
    return { data: { resourceType: 'Patient', id: 'fhir-patient-1' }, headers: {} };
  };
  try {
    const result = await ehrbaseConnectionAuthPlugins['hip-keycloak'].createFhirPatient(connection(), values);
    assert.equal(result.fhirPatientId, 'fhir-patient-1');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, 'https://fhir.example/fhir/R4/Patient');
    assert.equal(calls[1].config.headers.Authorization, 'Bearer same-hip-token');
    assert.equal(calls[1].config.headers['Content-Type'], 'application/fhir+json');
    assert.equal(calls[1].config.headers['If-None-Exist'], undefined);
    assert.equal(calls[1].body.resourceType, 'Patient');
  } finally {
    axios.post = originalPost;
  }
});

test('FHIR OperationOutcome diagnostics are surfaced in the HIP error', async () => {
  const originalPost = axios.post;
  let call = 0;
  axios.post = async () => {
    call += 1;
    if (call === 1) return { data: { access_token: 'hip-token', expires_in: 300 }, headers: {} };
    const error = new Error('Request failed');
    error.response = { status: 422, data: { resourceType: 'OperationOutcome', issue: [{ diagnostics: 'ISiK profile validation failed' }] } };
    throw error;
  };
  try {
    await assert.rejects(
      () => ehrbaseConnectionAuthPlugins['hip-keycloak'].createFhirPatient(connection(), values),
      /HTTP 422.*ISiK profile validation failed/,
    );
  } finally {
    axios.post = originalPost;
  }
});
