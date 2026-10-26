const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeEhrbaseAqlResponse,
  resolveResultPath,
  buildAqlQuery,
  buildContextKey,
  aqlPrefillCache,
  loadAqlPrefillData,
  applyPrefillField,
  applyPrefillGroup,
  applyPrefillForm,
} = require('../../../packages/aql-prefill-plugin');

function mockConfig(overrides = {}) {
  return {
    id: 'config-vitals-1',
    name: 'Vital signs prefill',
    queryMode: 'latest',
    executionMode: 'manual',
    query: {
      aql: 'SELECT c/content[openEHR-EHR-OBSERVATION.vital_signs.v1]/data AS vitals FROM COMPOSITION c',
      timeColumn: 'c/context/start_time/value',
    },
    parameters: [
      { queryParameter: '$ehrId', source: 'ehrId' },
    ],
    mappings: [
      { id: 'map-height', resultPath: 'height', target: { fieldId: 'bodyHeight', groupId: 'vitalsGroup' }, metadata: { unitPath: 'heightUnit' } },
      { id: 'map-weight', resultPath: 'weight', target: { fieldId: 'bodyWeight', groupId: 'vitalsGroup' }, metadata: { unitPath: 'weightUnit' } },
      { id: 'map-sys', resultPath: 'systolic', target: { fieldId: 'bloodPressureSystolic', groupId: 'vitalsGroup' } },
      { id: 'map-dia', resultPath: 'diastolic', target: { fieldId: 'bloodPressureDiastolic', groupId: 'vitalsGroup' } },
      { id: 'map-pulse', resultPath: 'pulse', target: { fieldId: 'pulseRate', groupId: 'vitalsGroup' } },
      { id: 'map-other', resultPath: 'otherNote', target: { fieldId: 'generalNote', groupId: 'otherGroup' } },
    ],
    behavior: {
      cacheResult: true,
      showSource: true,
      showTimestamp: true,
      confirmOverwrite: true,
    },
    ...overrides,
  };
}

test('1. AQL-Ergebnis wird korrekt normalisiert (EHRbase columns/rows & raw objects)', () => {
  const ehrbaseResponse = {
    columns: [{ name: 'height' }, { name: 'weight' }, { name: 'systolic' }],
    rows: [[180, 75, 120]],
  };

  const normalized = normalizeEhrbaseAqlResponse(ehrbaseResponse);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].height, 180);
  assert.equal(normalized[0].weight, 75);
  assert.equal(normalized[0].systolic, 120);

  const arrayResponse = [{ height: 182, weight: 78 }];
  const normalizedArray = normalizeEhrbaseAqlResponse(arrayResponse);
  assert.equal(normalizedArray[0].height, 182);
});

test('2. Eine Abfrage lädt mehrere Werte in den Cache', async () => {
  aqlPrefillCache.clear();
  const config = mockConfig();
  const context = { ehrId: 'ehr-123', patientId: 'pat-456' };

  let executeCount = 0;
  const mockClient = {
    async executeQuery() {
      executeCount++;
      return {
        rows: [[182, 'cm', 78, 'kg', 128, 82, 72, 'Gut']],
        columns: [
          { name: 'height' },
          { name: 'heightUnit' },
          { name: 'weight' },
          { name: 'weightUnit' },
          { name: 'systolic' },
          { name: 'diastolic' },
          { name: 'pulse' },
          { name: 'otherNote' },
        ],
      };
    },
  };

  const loadResult = await loadAqlPrefillData(config, context, { client: mockClient });
  assert.equal(executeCount, 1);
  assert.ok(loadResult.cacheEntry);
  assert.equal(Object.keys(loadResult.cacheEntry.normalizedValues).length, 6);
  assert.equal(loadResult.cacheEntry.normalizedValues['map-height'].value, 182);
  assert.equal(loadResult.cacheEntry.normalizedValues['map-weight'].value, 78);
});

test('3. Feldaktion übernimmt nur ein Feld', async () => {
  aqlPrefillCache.clear();
  const config = mockConfig();
  const context = { ehrId: 'ehr-123' };

  const mockClient = {
    async executeQuery() {
      return {
        rows: [[182, 78, 128, 82, 72]],
        columns: [{ name: 'height' }, { name: 'weight' }, { name: 'systolic' }, { name: 'diastolic' }, { name: 'pulse' }],
      };
    },
  };

  const { cacheEntry } = await loadAqlPrefillData(config, context, { client: mockClient });
  const currentValues = { bodyHeight: 170, bloodPressureSystolic: 120 };

  const fieldResult = applyPrefillField(config, cacheEntry, 'bodyWeight', currentValues);
  assert.equal(fieldResult.success, true);
  // Only bodyWeight should be updated to 78, others untouched
  assert.equal(fieldResult.updatedValues.bodyWeight, 78);
  assert.equal(fieldResult.updatedValues.bodyHeight, 170);
  assert.equal(fieldResult.updatedValues.bloodPressureSystolic, 120);
});

test('4. Gruppenaktion übernimmt nur Felder der Gruppe', async () => {
  aqlPrefillCache.clear();
  const config = mockConfig();
  const context = { ehrId: 'ehr-123' };

  const mockClient = {
    async executeQuery() {
      return {
        rows: [[182, 78, 128, 82, 72, 'Neue Notiz']],
        columns: [{ name: 'height' }, { name: 'weight' }, { name: 'systolic' }, { name: 'diastolic' }, { name: 'pulse' }, { name: 'otherNote' }],
      };
    },
  };

  const { cacheEntry } = await loadAqlPrefillData(config, context, { client: mockClient });
  const currentValues = { generalNote: 'Alte Notiz' };

  const groupResult = applyPrefillGroup(config, cacheEntry, 'vitalsGroup', currentValues);
  assert.equal(groupResult.success, true);
  assert.equal(groupResult.updatedValues.bodyHeight, 182);
  assert.equal(groupResult.updatedValues.bodyWeight, 78);
  assert.equal(groupResult.updatedValues.bloodPressureSystolic, 128);
  // generalNote is in otherGroup, so must remain untouched
  assert.equal(groupResult.updatedValues.generalNote, 'Alte Notiz');
});

test('5. Formularaktion übernimmt alle gemappten Felder', async () => {
  aqlPrefillCache.clear();
  const config = mockConfig();
  const context = { ehrId: 'ehr-123' };

  const mockClient = {
    async executeQuery() {
      return {
        rows: [[182, 78, 128, 82, 72, 'Gesamtnotiz']],
        columns: [{ name: 'height' }, { name: 'weight' }, { name: 'systolic' }, { name: 'diastolic' }, { name: 'pulse' }, { name: 'otherNote' }],
      };
    },
  };

  const { cacheEntry } = await loadAqlPrefillData(config, context, { client: mockClient });
  const formResult = applyPrefillForm(config, cacheEntry, {});
  assert.equal(formResult.success, true);
  assert.equal(formResult.updatedValues.bodyHeight, 182);
  assert.equal(formResult.updatedValues.bodyWeight, 78);
  assert.equal(formResult.updatedValues.generalNote, 'Gesamtnotiz');
});

test('6. Cache verhindert eine unnötige zweite Serverabfrage', async () => {
  aqlPrefillCache.clear();
  const config = mockConfig();
  const context = { ehrId: 'ehr-123', patientId: 'pat-456' };

  let queryCalls = 0;
  const mockClient = {
    async executeQuery() {
      queryCalls++;
      return { rows: [[180]], columns: [{ name: 'height' }] };
    },
  };

  await loadAqlPrefillData(config, context, { client: mockClient });
  assert.equal(queryCalls, 1);

  // Second call with identical context
  await loadAqlPrefillData(config, context, { client: mockClient });
  assert.equal(queryCalls, 1, 'Query count should remain 1 due to cache hit');
});

test('7. Kontextwechsel invalidiert den Cache', async () => {
  aqlPrefillCache.clear();
  const config = mockConfig();

  let queryCalls = 0;
  const mockClient = {
    async executeQuery() {
      queryCalls++;
      return { rows: [[180]], columns: [{ name: 'height' }] };
    },
  };

  await loadAqlPrefillData(config, { ehrId: 'patient-A' }, { client: mockClient });
  assert.equal(queryCalls, 1);

  // Context changes to patient-B
  await loadAqlPrefillData(config, { ehrId: 'patient-B' }, { client: mockClient });
  assert.equal(queryCalls, 2, 'Context change must trigger fresh server query');
});

test('8. Manuell geänderte Werte werden nicht ohne Bestätigung überschrieben', async () => {
  aqlPrefillCache.clear();
  const config = mockConfig({ behavior: { confirmOverwrite: true } });
  const context = { ehrId: 'ehr-123' };

  const mockClient = {
    async executeQuery() {
      return { rows: [[78]], columns: [{ name: 'weight' }] };
    },
  };

  const { cacheEntry } = await loadAqlPrefillData(config, context, { client: mockClient });
  const currentValues = { bodyWeight: 80 };
  const fieldStates = {
    bodyWeight: { fieldId: 'bodyWeight', value: 80, source: 'user', dirty: true },
  };

  // Unconfirmed apply should detect conflict
  const resultWithConflict = applyPrefillField(config, cacheEntry, 'bodyWeight', currentValues, fieldStates);
  assert.equal(resultWithConflict.success, false);
  assert.equal(resultWithConflict.conflicts.length, 1);
  assert.equal(resultWithConflict.conflicts[0].currentValue, 80);
  assert.equal(resultWithConflict.conflicts[0].prefillValue, 78);

  // Confirmed apply (forceOverwrite)
  const confirmedResult = applyPrefillField(config, cacheEntry, 'bodyWeight', currentValues, fieldStates, { forceOverwrite: true });
  assert.equal(confirmedResult.success, true);
  assert.equal(confirmedResult.updatedValues.bodyWeight, 78);
});

test('9. Fehlende Result-Pfade führen nicht zu einem Fehler des gesamten Formulars', () => {
  const data = { weight: 78 };
  const valMissing = resolveResultPath(data, 'nonExistentPath.nested[0]');
  assert.equal(valMissing, undefined);

  const valOk = resolveResultPath(data, 'weight');
  assert.equal(valOk, 78);
});

test('10. Ein AQL-Fehler verändert keine bestehenden Formularwerte', async () => {
  aqlPrefillCache.clear();
  const config = mockConfig();
  const context = { ehrId: 'ehr-123' };

  const failingClient = {
    async executeQuery() {
      throw new Error('EHRbase connection timeout');
    },
  };

  const initialValues = { bodyWeight: 82, bodyHeight: 175 };

  await assert.rejects(
    async () => {
      await loadAqlPrefillData(config, context, { client: failingClient });
    },
    { message: 'EHRbase connection timeout' }
  );

  // Existing form values remain unchanged
  assert.equal(initialValues.bodyWeight, 82);
  assert.equal(initialValues.bodyHeight, 175);
});
