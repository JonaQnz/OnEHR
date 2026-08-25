const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeCanonicalFormPayload } = require('../dist/validation/formValidation');
const { parseWebTemplate } = require('../dist/parsers/webTemplateParser');
const { generateCanonicalForm } = require('../dist/services/formGenerator');
const { migrateCanonicalFormToV1 } = require('core');
const { getElementMetadata, resolveElementsByNodeId } = require('openehr-engine');

test('canonical payload always uses the database form ID', () => {
  const form = normalizeCanonicalFormPayload({
    id: 'untrusted-client-id',
    name: 'Vitals',
    version: '1.0.0',
    sourceTemplates: [],
    layout: { type: 'form', children: [] },
    bindings: {},
    locales: { en: {} },
  }, 'database-id');

  assert.equal(form.id, 'database-id');
});

test('canonical payload rejects structurally invalid forms', () => {
  assert.throws(
    () => normalizeCanonicalFormPayload({ name: 'Broken' }, 'database-id'),
    /version/,
  );
});

test('web template parser maps common openEHR value types explicitly', () => {
  const result = parseWebTemplate({
    templateId: 'test-template',
    tree: {
      id: 'T0',
      rmType: 'COMPOSITION',
      children: [
        { id: 'date', rmType: 'DV_DATE', aqlPath: '/date' },
        { id: 'date_time', rmType: 'DV_DATE_TIME', aqlPath: '/date_time' },
        { id: 'time', rmType: 'DV_TIME', aqlPath: '/time' },
        { id: 'boolean', rmType: 'DV_BOOLEAN', aqlPath: '/boolean' },
        { id: 'count', rmType: 'DV_COUNT', aqlPath: '/count' },
        { id: 'ordinal', rmType: 'DV_ORDINAL', aqlPath: '/ordinal' },
        { id: 'duration', rmType: 'DV_DURATION', aqlPath: '/duration' },
      ],
    },
  });

  const types = Object.fromEntries(result.fields.map((field) => [field.technicalName, field.dataType]));
  assert.deepEqual(types, {
    date: 'date',
    date_time: 'date-time',
    time: 'time',
    boolean: 'boolean',
    count: 'number',
    ordinal: 'ordinal',
    duration: 'duration',
  });
  assert.deepEqual(result.fields.find((field) => field.technicalName === 'boolean').options, [
    { value: 'true', text: 'Yes' },
    { value: 'false', text: 'No' },
  ]);
});

// A realistic nested/repeating tree matching the epic's own worked example
// (systolic blood pressure): COMPOSITION -> OBSERVATION -> HISTORY (technical
// wrapper, collapses) -> repeatable EVENT -> ITEM_TREE (technical wrapper,
// collapses) -> DV_QUANTITY leaf.
function bloodPressureTemplate() {
  return {
    templateId: 'vital_signs_icu.v1',
    tree: {
      id: 'vital_signs', rmType: 'COMPOSITION', aqlPath: '',
      children: [{
        id: 'blood_pressure', name: 'Blood pressure', rmType: 'OBSERVATION',
        aqlPath: '/content[openEHR-EHR-OBSERVATION.blood_pressure.v2]',
        children: [{
          id: 'data', rmType: 'HISTORY', aqlPath: '/content[openEHR-EHR-OBSERVATION.blood_pressure.v2]/data[at0001]',
          children: [{
            id: 'any_event', name: 'Any event', rmType: 'EVENT', min: 1, max: -1,
            aqlPath: '/content[openEHR-EHR-OBSERVATION.blood_pressure.v2]/data[at0001]/events[at0006]',
            children: [{
              id: 'data', rmType: 'ITEM_TREE', aqlPath: '/content[openEHR-EHR-OBSERVATION.blood_pressure.v2]/data[at0001]/events[at0006]/data[at0003]',
              children: [{
                id: 'systolic', name: 'Systolic', rmType: 'DV_QUANTITY', min: 1,
                aqlPath: '/content[openEHR-EHR-OBSERVATION.blood_pressure.v2]/data[at0001]/events[at0006]/data[at0003]/items[at0004]',
                inputs: [{ suffix: 'unit', list: [{ value: 'mm[Hg]' }] }],
              }],
            }],
          }],
        }],
      }],
    },
  };
}

// Test 1 - basic node: rmType/nodeId/archetype+template paths all present
test('parser extracts archetypeNodeId/archetypeId/rmVersion for a DV_QUANTITY leaf', () => {
  const result = parseWebTemplate(bloodPressureTemplate());
  const systolic = result.fields.find((field) => field.technicalName === 'systolic');
  assert.equal(systolic.archetypeNodeId, 'at0004');
  assert.equal(systolic.archetypeId, 'openEHR-EHR-OBSERVATION.blood_pressure.v2');
  assert.equal(systolic.rmVersion, 'v2');
  assert.equal(systolic.rmType, 'DV_QUANTITY');
});

// Test 3/4 - the repeating EVENT container itself now carries a real
// binding too (not just its leaf), and the leaf's layout node - previously
// never given a binding at all - now carries its own directly.
function findNode(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children || []) { const found = findNode(child, predicate); if (found) return found; }
  return undefined;
}

test('generated layout carries binding on both the leaf and its repeatable container', () => {
  const result = parseWebTemplate(bloodPressureTemplate());
  const eventContainer = findNode(result.layout, (node) => node.repeatable === true);
  assert.ok(eventContainer, 'the repeatable EVENT container survives collapsing');
  assert.equal(eventContainer.binding?.rmType, 'EVENT');
  assert.equal(eventContainer.binding?.archetypeId, 'openEHR-EHR-OBSERVATION.blood_pressure.v2');

  const leaf = findNode(result.layout, (node) => node.id === 'systolic');
  assert.ok(leaf, 'the systolic leaf node exists in the generated layout');
  assert.equal(leaf.name, result.fields.find((f) => f.technicalName === 'systolic').fieldName, 'leaf still carries the field-name alias used by the legacy bindings map');
  assert.equal(leaf.binding?.archetypeNodeId, 'at0004');
  assert.equal(leaf.binding?.rmType, 'DV_QUANTITY');
});

// Test 7 - full roundtrip: WebTemplate -> parse -> generate -> canonical
// JSON -> re-normalize (migrateCanonicalFormToV1, the read-time choke
// point every form load goes through) -> nothing openEHR-relevant lost.
test('WebTemplate -> canonical form -> re-normalize roundtrip preserves all openEHR metadata', () => {
  const parsed = parseWebTemplate(bloodPressureTemplate());
  const generated = generateCanonicalForm({
    name: 'Blood Pressure', templateId: parsed.templateId, alias: parsed.alias,
    fields: parsed.fields, layout: parsed.layout, id: 'form-1', templateVersion: '1.2.0',
  });
  const reloaded = migrateCanonicalFormToV1(generated, 'form-1');

  // getElementMetadata is looked up by the layout node's own id (the raw
  // WebTemplate node id, e.g. "systolic") - not the longer alias-prefixed
  // fieldName the legacy bindings map (and node.name) use. Confirms the two
  // identifiers stay correctly distinct through the whole roundtrip.
  const metadata = getElementMetadata(reloaded, 'systolic');
  assert.equal(metadata.archetypeNodeId, 'at0004');
  assert.equal(metadata.archetypeId, 'openEHR-EHR-OBSERVATION.blood_pressure.v2');
  assert.equal(metadata.rmVersion, 'v2');
  assert.equal(metadata.rmType, 'DV_QUANTITY');
  assert.equal(metadata.templateId, 'vital_signs_icu.v1');
  assert.equal(metadata.templateVersion, '1.2.0');

  // Every occurrence of at0004 anywhere in the tree resolves through the
  // Path Engine, not just a hand-picked id.
  const occurrences = resolveElementsByNodeId(reloaded, 'at0004');
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].binding.archetypeId, metadata.archetypeId);
});
