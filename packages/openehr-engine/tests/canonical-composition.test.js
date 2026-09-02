const assert = require('node:assert/strict');
const test = require('node:test');
const { buildCanonicalComposition } = require('../dist');

// A trimmed but realistic WebTemplate tree: COMPOSITION -> category, context
// (EVENT_CONTEXT), and one ADMIN_ENTRY with a plain DV_TEXT/DV_QUANTITY leaf
// plus one repeatable CLUSTER (row-scoped group). Shapes match what
// getRemoteWebTemplate() actually returns (root has no aqlPath; category
// exposes its single allowed code via inputs[0].list; EVENT_CONTEXT exposes
// named children, not an items array).
const webTemplateTree = {
  id: 'vitals',
  name: 'Vitals',
  rmType: 'COMPOSITION',
  nodeId: 'openEHR-EHR-COMPOSITION.encounter.v1',
  children: [
    {
      id: 'category', name: 'category', rmType: 'DV_CODED_TEXT', min: 1, max: 1,
      aqlPath: '/category',
      inputs: [{ suffix: 'code', type: 'CODED_TEXT', list: [{ value: '433', label: 'event' }] }],
    },
    {
      id: 'context', name: 'context', rmType: 'EVENT_CONTEXT', min: 1, max: 1,
      children: [
        { id: 'start_time', name: 'start_time', rmType: 'DV_DATE_TIME', min: 1, max: 1, aqlPath: '/context/start_time' },
        { id: 'setting', name: 'setting', rmType: 'DV_CODED_TEXT', min: 1, max: 1, aqlPath: '/context/setting' },
      ],
    },
    {
      id: 'vitals_entry', name: 'Vitals', rmType: 'ADMIN_ENTRY', min: 0, max: 1,
      nodeId: 'openEHR-EHR-ADMIN_ENTRY.vitals.v1', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]',
      children: [
        {
          id: 'weight', name: 'Weight', rmType: 'DV_QUANTITY', min: 0, max: 1,
          nodeId: 'at0002', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0002]',
        },
        {
          id: 'notes', name: 'Notes', rmType: 'DV_TEXT', min: 0, max: -1,
          nodeId: 'at0003', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0003]',
        },
        {
          // WebTemplate reports this slot as the concrete DV_CODED_TEXT -
          // mirrors "Diagnostic category" (at0063) in the real vg_Diagnosis
          // template, which is what the codeMappings-override regression
          // test below reproduces.
          id: 'qualifier_category', name: 'Category qualifier', rmType: 'DV_CODED_TEXT', min: 0, max: 1,
          nodeId: 'at0007', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0007]',
        },
        {
          id: 'medication', name: 'Medication', rmType: 'CLUSTER', min: 0, max: -1,
          nodeId: 'at0004', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0004]',
          children: [
            { id: 'substance', name: 'Substance', rmType: 'DV_TEXT', min: 1, max: 1, nodeId: 'at0005', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0004]/items[at0005]' },
            { id: 'dose', name: 'Dose', rmType: 'DV_QUANTITY', min: 0, max: 1, nodeId: 'at0006', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0004]/items[at0006]' },
          ],
        },
      ],
    },
  ],
};

const definition = {
  id: 'vitals-form', name: 'Vitals', version: '1.0.0',
  sourceTemplates: [{ alias: 'vitals', id: 'vitals.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
  locales: { en: {} },
  bindings: {},
  layout: {
    type: 'form',
    children: [
      { id: 'setting', type: 'select', binding: { path: '/context/setting', rmType: 'DV_CODED_TEXT' }, options: [{ value: '238', text: 'other care' }] },
      { id: 'weight', type: 'quantity', binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0002]', rmType: 'DV_QUANTITY' } },
      { id: 'notes', type: 'input-text', binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0003]', rmType: 'DV_TEXT' } },
      {
        id: 'medication', type: 'container', repeatable: true,
        children: [
          { id: 'substance', type: 'input-text', binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0004]/items[at0005]', rmType: 'DV_TEXT' } },
          { id: 'dose', type: 'quantity', binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0004]/items[at0006]', rmType: 'DV_QUANTITY' } },
        ],
      },
    ],
  },
};

test('builds a canonical Composition with category/context defaults, a leaf, a repeatable leaf, and a repeatable group', () => {
  const values = {
    setting: '238',
    weight: { magnitude: 70, unit: 'kg' },
    notes: ['first note', 'second note'],
    medication: [
      { substance: 'Ibuprofen', dose: { magnitude: 400, unit: 'mg' } },
      { substance: 'Paracetamol' },
    ],
  };
  const composition = buildCanonicalComposition(definition, values, webTemplateTree, {
    language: 'de', territory: 'DE', time: '2026-08-26T10:00:00.000Z', composerName: 'Dr. Test',
  });

  assert.equal(composition._type, 'COMPOSITION');
  assert.equal(composition.archetype_node_id, 'openEHR-EHR-COMPOSITION.encounter.v1');
  assert.deepEqual(composition.category, { _type: 'DV_CODED_TEXT', value: 'event', defining_code: { _type: 'CODE_PHRASE', terminology_id: { _type: 'TERMINOLOGY_ID', value: 'openehr' }, code_string: '433' } });
  assert.equal(composition.context.start_time.value, '2026-08-26T10:00:00.000Z');
  assert.equal(composition.context.setting.defining_code.code_string, '238');
  assert.equal(composition.context.setting.value, 'other care');

  const entry = composition.content[0];
  assert.equal(entry._type, 'ADMIN_ENTRY');
  assert.equal(entry.subject._type, 'PARTY_SELF');
  const items = entry.data.items;
  const weightEl = items.find((item) => item.archetype_node_id === 'at0002');
  // RM attribute name is `units` (plural, mandatory) - not `unit`. See
  // buildLeafDvValue's DV_QUANTITY branch comment for the live-bug context.
  assert.deepEqual(weightEl.value, { _type: 'DV_QUANTITY', magnitude: 70, units: 'kg' });

  const noteEls = items.filter((item) => item.archetype_node_id === 'at0003');
  assert.equal(noteEls.length, 2);
  assert.deepEqual(noteEls.map((el) => el.value.value), ['first note', 'second note']);

  const medClusters = items.filter((item) => item.archetype_node_id === 'at0004');
  assert.equal(medClusters.length, 2);
  const first = medClusters[0].items.find((item) => item.archetype_node_id === 'at0005');
  assert.equal(first.value.value, 'Ibuprofen');
  const firstDose = medClusters[0].items.find((item) => item.archetype_node_id === 'at0006');
  assert.deepEqual(firstDose.value, { _type: 'DV_QUANTITY', magnitude: 400, units: 'mg' });
  const second = medClusters[1].items.find((item) => item.archetype_node_id === 'at0005');
  assert.equal(second.value.value, 'Paracetamol');
  // Second row has no dose value at all - the optional leaf is omitted, not fabricated.
  assert.equal(medClusters[1].items.find((item) => item.archetype_node_id === 'at0006'), undefined);
});

// Regression: RM data_types.quantity 6.2.8 defines DV_QUANTITY's mandatory
// (1..1) unit attribute as `units` (plural) - this app previously wrote
// `unit` (singular, not a real RM attribute) into the canonical composition
// JSON, silently violating the RM invariant for every quantity-bound field
// in the app (vitals, lab magnitudes, anything numeric with a unit). The
// FLAT-format path is unaffected and deliberately different - EHRbase's own
// FLAT suffix convention for this really is `|unit` (singular).
test('DV_QUANTITY serializes the RM-mandatory unit attribute as `units`, not `unit`', () => {
  const quantityDefinition = {
    ...definition,
    layout: {
      type: 'form',
      children: [{
        id: 'weight', type: 'quantity',
        binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0002]', rmType: 'DV_QUANTITY' },
      }],
    },
  };
  const composition = buildCanonicalComposition(quantityDefinition, {
    weight: { magnitude: 82, unit: 'kg' },
  }, webTemplateTree, { time: '2026-08-26T10:00:00.000Z' });
  const weightEl = composition.content[0].data.items.find((item) => item.archetype_node_id === 'at0002');
  assert.equal(weightEl.value.units, 'kg');
  assert.equal('unit' in weightEl.value, false);
});

// RM data_types.quantity: DV_COUNT.magnitude is Integer, not Real, unlike
// DV_QUANTITY - but getInputType() gives a DV_COUNT-bound field the same
// generic 'input-number' widget as DV_DECIMAL, with nothing upstream
// enforcing integer-only input, so a fractional value can genuinely reach
// this serializer.
test('DV_COUNT rounds a fractional magnitude to an integer, since the RM type does not allow Real', () => {
  // buildNode resolves the WebTemplate node's OWN declared rmType (not the
  // form binding's), so this needs a dedicated tree with an at-code
  // genuinely declared DV_COUNT - the shared fixture's at0002 is DV_QUANTITY.
  const countTree = {
    id: 'vitals', name: 'Vitals', rmType: 'COMPOSITION', nodeId: 'openEHR-EHR-COMPOSITION.encounter.v1',
    children: [
      { id: 'category', name: 'category', rmType: 'DV_CODED_TEXT', min: 1, max: 1, aqlPath: '/category', inputs: [{ suffix: 'code', type: 'CODED_TEXT', list: [{ value: '433', label: 'event' }] }] },
      { id: 'context', name: 'context', rmType: 'EVENT_CONTEXT', min: 1, max: 1, children: [
        { id: 'start_time', name: 'start_time', rmType: 'DV_DATE_TIME', min: 1, max: 1, aqlPath: '/context/start_time' },
        { id: 'setting', name: 'setting', rmType: 'DV_CODED_TEXT', min: 1, max: 1, aqlPath: '/context/setting' },
      ] },
      {
        id: 'vitals_entry', name: 'Vitals', rmType: 'ADMIN_ENTRY', min: 0, max: 1,
        nodeId: 'openEHR-EHR-ADMIN_ENTRY.vitals.v1', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]',
        children: [
          { id: 'count', name: 'Count', rmType: 'DV_COUNT', min: 0, max: 1, nodeId: 'at0002', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0002]' },
        ],
      },
    ],
  };
  const countDefinition = {
    ...definition,
    layout: {
      type: 'form',
      children: [
        { id: 'setting', type: 'select', binding: { path: '/context/setting', rmType: 'DV_CODED_TEXT' }, options: [{ value: '238', text: 'other care' }] },
        { id: 'count', type: 'input-number', binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0002]', rmType: 'DV_COUNT' } },
      ],
    },
  };
  const composition = buildCanonicalComposition(countDefinition, { count: '3.7' }, countTree, { time: '2026-08-26T10:00:00.000Z' });
  const countEl = composition.content[0].data.items.find((item) => item.archetype_node_id === 'at0002');
  assert.equal(countEl.value._type, 'DV_COUNT');
  assert.equal(countEl.value.magnitude, 4);
  assert.equal(Number.isInteger(countEl.value.magnitude), true);
});

test('omits an entirely-empty optional ADMIN_ENTRY rather than emitting an empty shell', () => {
  const composition = buildCanonicalComposition(definition, { setting: '238' }, webTemplateTree, { time: '2026-08-26T10:00:00.000Z' });
  assert.deepEqual(composition.content, []);
});

test('throws a clear error when the WebTemplate tree is not rooted at a COMPOSITION', () => {
  assert.throws(() => buildCanonicalComposition(definition, {}, { rmType: 'OBSERVATION' }), /rooted at a COMPOSITION/);
});

test('OBSERVATION with a flattened HISTORY/EVENT wrapper gets correct archetype_node_id at every level, including the nested inner ITEM_TREE', () => {
  // Confirmed live (vg_ObservationLab.v1.2.0): the WebTemplate tree omits
  // the HISTORY/EVENT/ITEM_TREE wrapper nodes entirely, exposing the
  // event's own leaf fields as direct children of a flattened structure -
  // and the SAME aqlPath contains two different `/data[atXXXX]` segments
  // (the OBSERVATION's own top slot, at0001, and the EVENT's inner
  // ITEM_TREE slot, at0003) - picking the wrong one silently mislabels a
  // real RM node and EHRbase rejects the whole commit ("not in template").
  const tree = {
    id: 'obs', name: 'ObsLab', rmType: 'COMPOSITION', nodeId: 'openEHR-EHR-COMPOSITION.report.v1',
    children: [{
      id: 'laboratory_test_result', name: 'Laboratory test result', rmType: 'OBSERVATION', min: 0, max: 1,
      nodeId: 'openEHR-EHR-OBSERVATION.laboratory_test_result.v1', aqlPath: '/content[openEHR-EHR-OBSERVATION.laboratory_test_result.v1]',
      children: [{
        id: 'any_event', name: 'Any event', rmType: 'EVENT', nodeId: 'at0002', min: 0, max: -1,
        aqlPath: '/content[openEHR-EHR-OBSERVATION.laboratory_test_result.v1]/data[at0001]/events[at0002]',
        children: [{ id: 'test_name', name: 'Test name', rmType: 'DV_TEXT', min: 0, max: 1, nodeId: 'at0005', aqlPath: '/content[openEHR-EHR-OBSERVATION.laboratory_test_result.v1]/data[at0001]/events[at0002]/data[at0003]/items[at0005]/value' }],
      }],
    }],
  };
  const definition = {
    id: 'obs-form', name: 'ObsLab', version: '1.0.0',
    sourceTemplates: [{ alias: 'obs', id: 'obs.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    locales: { en: {} },
    layout: { type: 'form', children: [{ id: 'test_name', type: 'input-text' }] },
    bindings: { test_name: { openehr: { templateAlias: 'obs', path: '/content[openEHR-EHR-OBSERVATION.laboratory_test_result.v1]/data[at0001]/events[at0002]/data[at0003]/items[at0005]/value', rmType: 'DV_TEXT' } } },
  };
  const composition = buildCanonicalComposition(definition, { test_name: 'positive' }, tree, { time: '2026-08-26T10:00:00.000Z' });
  const observation = composition.content[0];
  const history = observation.data;
  assert.equal(history._type, 'HISTORY');
  assert.equal(history.archetype_node_id, 'at0001'); // OBSERVATION's own top data slot
  const event = history.events[0];
  assert.equal(event.archetype_node_id, 'at0002'); // the EVENT itself
  assert.equal(event.data.archetype_node_id, 'at0003'); // the EVENT's own inner ITEM_TREE, not at0001
  assert.equal(event.data.items[0].value.value, 'positive');
});

test('OBSERVATION.protocol (a sibling branch of .data, e.g. requester_order_identifier) is built and attached, not silently dropped', () => {
  // Confirmed live (vg_ObservationLab.v1.2.0): requester_order_identifier
  // binds under /protocol[at0004]/items[at0094]/items[at0062]/value, a
  // sibling of the OBSERVATION's own /data[at0001] branch, not nested under
  // it. A real submission with this field filled committed successfully but
  // read back with `protocol: null` via AQL - buildObservationData only
  // ever builds `data`; nothing built `protocol` at all, even though
  // isEntryMetaChild already correctly excludes protocol children from the
  // `data` walk (so they were excluded from data.items and simply never
  // reappeared anywhere).
  const tree = {
    id: 'obs', name: 'ObsLab', rmType: 'COMPOSITION', nodeId: 'openEHR-EHR-COMPOSITION.report.v1',
    children: [{
      id: 'laboratory_test_result', name: 'Laboratory test result', rmType: 'OBSERVATION', min: 0, max: 1,
      nodeId: 'openEHR-EHR-OBSERVATION.laboratory_test_result.v1', aqlPath: '/content[openEHR-EHR-OBSERVATION.laboratory_test_result.v1]',
      children: [
        {
          id: 'any_event', name: 'Any event', rmType: 'EVENT', nodeId: 'at0002', min: 0, max: -1,
          aqlPath: '/content[openEHR-EHR-OBSERVATION.laboratory_test_result.v1]/data[at0001]/events[at0002]',
          children: [{ id: 'test_name', name: 'Test name', rmType: 'DV_TEXT', min: 0, max: 1, nodeId: 'at0005', aqlPath: '/content[openEHR-EHR-OBSERVATION.laboratory_test_result.v1]/data[at0001]/events[at0002]/data[at0003]/items[at0005]/value' }],
        },
        {
          id: 'test_request_details', name: 'Test request details', rmType: 'CLUSTER', min: 0, max: 1,
          nodeId: 'openEHR-EHR-CLUSTER.test_request_details.v1', aqlPath: '/content[openEHR-EHR-OBSERVATION.laboratory_test_result.v1]/protocol[at0004]/items[at0094]',
          children: [{ id: 'requester_order_identifier', name: 'Requester order identifier', rmType: 'DV_TEXT', min: 0, max: 1, nodeId: 'at0062', aqlPath: '/content[openEHR-EHR-OBSERVATION.laboratory_test_result.v1]/protocol[at0004]/items[at0094]/items[at0062]/value' }],
        },
      ],
    }],
  };
  const definition = {
    id: 'obs-form', name: 'ObsLab', version: '1.0.0',
    sourceTemplates: [{ alias: 'obs', id: 'obs.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    locales: { en: {} }, bindings: {},
    layout: {
      type: 'form',
      children: [
        { id: 'test_name', type: 'input-text', binding: { path: '/content[openEHR-EHR-OBSERVATION.laboratory_test_result.v1]/data[at0001]/events[at0002]/data[at0003]/items[at0005]/value', rmType: 'DV_TEXT' } },
        { id: 'requester_order_identifier', type: 'input-text', binding: { path: '/content[openEHR-EHR-OBSERVATION.laboratory_test_result.v1]/protocol[at0004]/items[at0094]/items[at0062]/value', rmType: 'DV_TEXT' } },
      ],
    },
  };
  const composition = buildCanonicalComposition(definition, { test_name: 'Leukozyten', requester_order_identifier: 'ORD-2026-5871' }, tree, { time: '2026-08-26T10:00:00.000Z' });
  const observation = composition.content[0];
  assert.ok(observation.protocol, 'OBSERVATION.protocol must be present when a protocol-bound field has a value');
  assert.equal(observation.protocol._type, 'ITEM_TREE');
  assert.equal(observation.protocol.archetype_node_id, 'at0004');
  const cluster = observation.protocol.items[0];
  assert.equal(cluster._type, 'CLUSTER');
  assert.equal(cluster.archetype_node_id, 'openEHR-EHR-CLUSTER.test_request_details.v1');
  assert.equal(cluster.items[0].value.value, 'ORD-2026-5871');
});

test('ACTION.protocol (DV_IDENTIFIER, the only declared alternative) is built and attached, not silently dropped', () => {
  // Confirmed live (vg_MedicationAdministration.v1.0.2): "ID der Verordnung"
  // /at0103 binds under /protocol[at0030]/items[at0103]/value and is
  // DV_IDENTIFIER-only (no DV_TEXT alternative to fall back to, unlike Lab's
  // requester_order_identifier) - same missing-`protocol`-attribute gap as
  // OBSERVATION, just on ACTION's own switch case.
  const tree = {
    id: 'obs', name: 'MedAdmin', rmType: 'COMPOSITION', nodeId: 'openEHR-EHR-COMPOSITION.report.v1',
    children: [{
      id: 'medication', name: 'Medication', rmType: 'ACTION', min: 0, max: 1,
      nodeId: 'openEHR-EHR-ACTION.medication.v1', aqlPath: '/content[openEHR-EHR-ACTION.medication.v1]',
      children: [
        {
          id: 'description', name: 'Description', rmType: 'ITEM_TREE', min: 0, max: 1, nodeId: 'at0017',
          aqlPath: '/content[openEHR-EHR-ACTION.medication.v1]/description[at0017]',
          children: [{ id: 'arzneimittel', name: 'Arzneimittel', rmType: 'DV_TEXT', min: 0, max: 1, nodeId: 'at0020', aqlPath: '/content[openEHR-EHR-ACTION.medication.v1]/description[at0017]/items[at0020]/value' }],
        },
        { id: 'order_identifier', name: 'ID der Verordnung', rmType: 'DV_IDENTIFIER', min: 0, max: 1, nodeId: 'at0103', aqlPath: '/content[openEHR-EHR-ACTION.medication.v1]/protocol[at0030]/items[at0103]/value' },
      ],
    }],
  };
  const definition = {
    id: 'med-form', name: 'MedAdmin', version: '1.0.0',
    sourceTemplates: [{ alias: 'med', id: 'med.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    locales: { en: {} }, bindings: {},
    layout: {
      type: 'form',
      children: [
        { id: 'arzneimittel', type: 'input-text', binding: { path: '/content[openEHR-EHR-ACTION.medication.v1]/description[at0017]/items[at0020]/value', rmType: 'DV_TEXT' } },
        { id: 'order_identifier', type: 'input-text', binding: { path: '/content[openEHR-EHR-ACTION.medication.v1]/protocol[at0030]/items[at0103]/value', rmType: 'DV_IDENTIFIER' } },
      ],
    },
  };
  const composition = buildCanonicalComposition(definition, { arzneimittel: 'Paracetamol 1g', order_identifier: 'ORD-9001' }, tree, { time: '2026-08-26T10:00:00.000Z' });
  const action = composition.content[0];
  assert.ok(action.protocol, 'ACTION.protocol must be present when a protocol-bound field has a value');
  const el = action.protocol.items[0];
  assert.equal(el.value._type, 'DV_IDENTIFIER');
  assert.equal(el.value.id, 'ORD-9001');
  assert.equal('assigner' in el.value, false, 'no fabricated assigner/type for a plain-string DV_IDENTIFIER field');
});

test('ACTION.time and ACTION.ism_transition.current_state use a bound field\'s real value when the form provides one, not always the hardcoded default', () => {
  const tree = {
    id: 'obs', name: 'MedAdmin', rmType: 'COMPOSITION', nodeId: 'openEHR-EHR-COMPOSITION.report.v1',
    children: [{
      id: 'medication', name: 'Medication', rmType: 'ACTION', min: 0, max: 1,
      nodeId: 'openEHR-EHR-ACTION.medication.v1', aqlPath: '/content[openEHR-EHR-ACTION.medication.v1]',
      children: [{
        id: 'description', name: 'Description', rmType: 'ITEM_TREE', min: 0, max: 1, nodeId: 'at0017',
        aqlPath: '/content[openEHR-EHR-ACTION.medication.v1]/description[at0017]',
        children: [{ id: 'arzneimittel', name: 'Arzneimittel', rmType: 'DV_TEXT', min: 0, max: 1, nodeId: 'at0020', aqlPath: '/content[openEHR-EHR-ACTION.medication.v1]/description[at0017]/items[at0020]/value' }],
      }],
    }],
  };
  const definition = {
    id: 'med-form', name: 'MedAdmin', version: '1.0.0',
    sourceTemplates: [{ alias: 'med', id: 'med.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    locales: { en: {} }, bindings: {},
    layout: {
      type: 'form',
      children: [
        { id: 'arzneimittel', type: 'input-text', binding: { path: '/content[openEHR-EHR-ACTION.medication.v1]/description[at0017]/items[at0020]/value', rmType: 'DV_TEXT' } },
        { id: 'administration_time', type: 'input-date-time', binding: { path: '/content[openEHR-EHR-ACTION.medication.v1]/time', rmType: 'DV_DATE_TIME' } },
        { id: 'administration_status', type: 'input-select', binding: { path: '/content[openEHR-EHR-ACTION.medication.v1]/ism_transition/current_state', rmType: 'DV_CODED_TEXT' }, options: [{ text: 'Abgebrochen', value: '531' }] },
      ],
    },
  };
  const composition = buildCanonicalComposition(
    definition,
    { arzneimittel: 'Paracetamol 1g', administration_time: '2026-05-15T09:00:00Z', administration_status: '531' },
    tree,
    { time: '2026-08-26T10:00:00.000Z' }, // the fallback default - must NOT win when a real field value exists
  );
  const action = composition.content[0];
  assert.equal(action.time.value, '2026-05-15T09:00:00Z');
  assert.equal(action.ism_transition.current_state.defining_code.code_string, '531');

  // And the pre-existing hardcoded fallback still applies when no such field is bound at all (backward compatible).
  const fallbackDefinition = { ...definition, layout: { type: 'form', children: [definition.layout.children[0]] } };
  const fallbackComposition = buildCanonicalComposition(fallbackDefinition, { arzneimittel: 'Paracetamol 1g' }, tree, { time: '2026-08-26T10:00:00.000Z' });
  const fallbackAction = fallbackComposition.content[0];
  assert.equal(fallbackAction.time.value, '2026-08-26T10:00:00.000Z');
  assert.equal(fallbackAction.ism_transition.current_state.defining_code.code_string, '532');
});

test('resolves a layout binding wrapped as {openehr: {...}} on the node itself, not just node.binding.path directly', () => {
  // Confirmed live (vg_ObservationLab.v1.2.0's own layout): a field's short
  // `.id` differs from its long binding-map name, AND its `.binding` is
  // itself wrapped as `{openehr: {path, rmType}}` rather than the direct
  // `{path, rmType}` shape RuntimeFieldDescriptor.aqlPath alone reads -
  // without unwrapping this, the field silently resolves to no aqlPath at
  // all and the whole OBSERVATION it lives in vanishes from content[].
  const tree = {
    id: 'obs', name: 'Obs', rmType: 'COMPOSITION', nodeId: 'openEHR-EHR-COMPOSITION.report.v1',
    children: [{
      id: 'entry', name: 'Entry', rmType: 'ADMIN_ENTRY', min: 0, max: 1, nodeId: 'openEHR-EHR-ADMIN_ENTRY.vitals.v1', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]',
      children: [{ id: 'test_name', name: 'Test name', rmType: 'DV_TEXT', min: 0, max: 1, nodeId: 'at0005', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0005]' }],
    }],
  };
  const wrappedDefinition = {
    id: 'obs-form', name: 'Obs', version: '1.0.0',
    sourceTemplates: [{ alias: 'obs', id: 'obs.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    locales: { en: {} }, bindings: {},
    layout: {
      type: 'form',
      children: [{
        id: 'test_name', // short id
        name: 'vg_observationlab.v1.2.0_test_name', // long name, unrelated to any bindings-map key here
        type: 'input-text',
        binding: { openehr: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0005]', rmType: 'DV_TEXT' } },
      }],
    },
  };
  const composition = buildCanonicalComposition(wrappedDefinition, { test_name: 'Wrapped Binding Works' }, tree, { time: '2026-08-26T10:00:00.000Z' });
  assert.equal(composition.content.length, 1);
  const el = composition.content[0].data.items[0];
  assert.equal(el.value.value, 'Wrapped Binding Works');
});

test('resolves a polymorphic RM slot (WebTemplate rmType "ELEMENT") to whichever bound alternative actually has a value', () => {
  // Confirmed live (vg_ObservationLab.v1.2.0's laboratory_internal_identifier,
  // at0068): a union-typed archetype slot shows up as the ambiguous
  // `rmType: 'ELEMENT'` in the WebTemplate, with two form fields bound to
  // the identical aqlPath - one DV_TEXT, one DV_IDENTIFIER.
  const polymorphicTree = {
    id: 'obs', name: 'Obs', rmType: 'COMPOSITION', nodeId: 'openEHR-EHR-COMPOSITION.report.v1',
    children: [{
      id: 'entry', name: 'Entry', rmType: 'ADMIN_ENTRY', min: 0, max: 1, nodeId: 'openEHR-EHR-ADMIN_ENTRY.vitals.v1', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]',
      children: [{ id: 'internal_identifier', name: 'Internal identifier', rmType: 'ELEMENT', min: 0, max: 1, nodeId: 'at0068', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0068]' }],
    }],
  };
  const polymorphicDefinition = {
    id: 'obs-form', name: 'Obs', version: '1.0.0',
    sourceTemplates: [{ alias: 'obs', id: 'obs.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    locales: { en: {} },
    layout: { type: 'form', children: [{ id: 'text_alt', type: 'input-text' }, { id: 'identifier_alt', type: 'input-text' }] },
    bindings: {
      text_alt: { openehr: { templateAlias: 'obs', path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0068]', rmType: 'DV_TEXT' } },
      identifier_alt: { openehr: { templateAlias: 'obs', path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0068]', rmType: 'DV_IDENTIFIER' } },
    },
  };

  const asText = buildCanonicalComposition(polymorphicDefinition, { text_alt: 'LAB-123' }, polymorphicTree, { time: '2026-08-26T10:00:00.000Z' });
  const textEl = asText.content[0].data.items[0];
  assert.deepEqual(textEl.value, { _type: 'DV_TEXT', value: 'LAB-123' });

  const asIdentifier = buildCanonicalComposition(polymorphicDefinition, { identifier_alt: { id: 'LAB-456', type: 'lab-order' } }, polymorphicTree, { time: '2026-08-26T10:00:00.000Z' });
  const idEl = asIdentifier.content[0].data.items[0];
  assert.equal(idEl.value._type, 'DV_IDENTIFIER');
  assert.equal(idEl.value.id, 'LAB-456');
});

test('resolves fields bound via the legacy top-level definition.bindings envelope, not just layout.binding', () => {
  // Real production forms (Diagnosis, MedicationStatement, ...) store their
  // openEHR binding in the top-level `bindings` map, not on the layout node
  // itself - confirmed live. toOpenEhrFlatComposition already falls back to
  // this; the canonical builder must resolve fields identically.
  const legacyDefinition = {
    ...definition,
    layout: {
      type: 'form',
      children: [{ id: 'legacy_notes', name: 'legacy_notes', type: 'input-text' }],
    },
    bindings: {
      legacy_notes: { openehr: { templateAlias: 'vitals', path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0003]', rmType: 'DV_TEXT' } },
    },
  };
  const composition = buildCanonicalComposition(legacyDefinition, { setting: '238', legacy_notes: 'From legacy binding' }, webTemplateTree, { time: '2026-08-26T10:00:00.000Z' });
  const entry = composition.content[0];
  const noteEl = entry.data.items.find((item) => item.archetype_node_id === 'at0003');
  assert.equal(noteEl.value.value, 'From legacy binding');
});

// codeMappings.enabled fields (DV_TEXT.mappings, e.g. a free-text diagnosis
// name tagged with an ICD-10-GM code) - shape confirmed against a real
// production Composition (vg_Diagnosis.v1.1.0's "Problem/Diagnosis name":
// {_type:'DV_TEXT', value: '...', mappings: [{_type:'TERM_MAPPING', match:'=',
// target: {_type:'CODE_PHRASE', terminology_id:{...}, code_string:'F16.0'}}]}).
test('codeMappings.enabled: a DV_TEXT field with a mapping produces real DV_TEXT.mappings, matching a live production example', () => {
  const codedDefinition = {
    ...definition,
    layout: {
      type: 'form',
      children: [
        {
          id: 'notes', type: 'input-text',
          binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0003]', rmType: 'DV_TEXT' },
          codeMappings: { enabled: true, terminologies: [{ id: 'http://fhir.de/CodeSystem/dimdi/icd-10-gm', label: 'ICD-10-GM' }] },
        },
      ],
    },
  };
  const composition = buildCanonicalComposition(codedDefinition, {
    notes: { value: 'Psychische und Verhaltensstörungen durch Halluzinogene: Akute Intoxikation [akuter Rausch]', mappings: [{ terminologyId: 'http://fhir.de/CodeSystem/dimdi/icd-10-gm', code: 'F16.0' }] },
  }, webTemplateTree, { time: '2026-08-26T10:00:00.000Z' });
  const noteEl = composition.content[0].data.items.find((item) => item.archetype_node_id === 'at0003');
  assert.deepEqual(noteEl.value, {
    _type: 'DV_TEXT',
    value: 'Psychische und Verhaltensstörungen durch Halluzinogene: Akute Intoxikation [akuter Rausch]',
    mappings: [{
      _type: 'TERM_MAPPING',
      match: '=',
      target: { _type: 'CODE_PHRASE', terminology_id: { _type: 'TERMINOLOGY_ID', value: 'http://fhir.de/CodeSystem/dimdi/icd-10-gm' }, code_string: 'F16.0' },
    }],
  });
});

// Regression: live 400 from EHRbase - "DV_CODED_TEXT/defining_code/
// code_string does not match any option. found: Secondary diagnosis". Root
// cause: buildNode only trusted the binding's own declared rmType over the
// WebTemplate's when the template reported the ambiguous wrapper type
// 'ELEMENT' - for a WebTemplate slot with a concrete, unambiguous type
// (here DV_CODED_TEXT, exactly like vg_Diagnosis's real "Diagnostic
// category"/at0063), the binding's codeMappings-driven DV_TEXT override was
// silently ignored and the field was still built as DV_CODED_TEXT, turning
// the free-text value straight into an invalid defining_code.code_string.
test('codeMappings.enabled on a field the WebTemplate itself reports as DV_CODED_TEXT still serializes as DV_TEXT.mappings, not an invalid DV_CODED_TEXT', () => {
  const codedDefinition = {
    ...definition,
    layout: {
      type: 'form',
      children: [{
        id: 'category_qualifier', type: 'input-text',
        binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0007]', rmType: 'DV_TEXT' },
        codeMappings: { enabled: true, terminologies: [{ id: 'https://hip.vitagroup.ag/sid/condition-category-code', label: 'Kategorie-Code' }] },
      }],
    },
  };
  const composition = buildCanonicalComposition(codedDefinition, {
    category_qualifier: { value: 'Secondary diagnosis', mappings: [{ terminologyId: 'https://hip.vitagroup.ag/sid/condition-category-code', code: 'ND' }] },
  }, webTemplateTree, { time: '2026-08-26T10:00:00.000Z' });
  const el = composition.content[0].data.items.find((item) => item.archetype_node_id === 'at0007');
  assert.deepEqual(el.value, {
    _type: 'DV_TEXT',
    value: 'Secondary diagnosis',
    mappings: [{
      _type: 'TERM_MAPPING',
      match: '=',
      target: { _type: 'CODE_PHRASE', terminology_id: { _type: 'TERMINOLOGY_ID', value: 'https://hip.vitagroup.ag/sid/condition-category-code' }, code_string: 'ND' },
    }],
  });
});

// Mirror image of the regression above: the real HIP Condition mapping
// document requires "Problem/Diagnosis name" (at0002, WebTemplate rmType
// DV_TEXT) to be written as DV_CODED_TEXT with BOTH defining_code and
// mappings populated from the same code (storageClass "DvCodedText"),
// unlike "Diagnostic category" (at0063) which only needed DV_TEXT.mappings.
// A deliberate, explicit bend of RM data_types.text 5.2.4's own "Misuse"
// guidance for free text tagged with a code - HIP's own converter
// contract wins here per product decision, not RM purity.
test('codeMappings.enabled on a DV_CODED_TEXT binding builds both defining_code and mappings from the same code, even though the WebTemplate itself reports the node as DV_TEXT', () => {
  const codedDefinition = {
    ...definition,
    layout: {
      type: 'form',
      children: [{
        id: 'notes', type: 'input-text',
        binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0003]', rmType: 'DV_CODED_TEXT' },
        codeMappings: { enabled: true, terminologies: [{ id: 'http://fhir.de/CodeSystem/dimdi/icd-10-gm', label: 'ICD-10-GM' }] },
      }],
    },
  };
  const composition = buildCanonicalComposition(codedDefinition, {
    notes: { value: 'Test3', mappings: [{ terminologyId: 'http://fhir.de/CodeSystem/dimdi/icd-10-gm', code: 'M10.2' }] },
  }, webTemplateTree, { time: '2026-08-26T10:00:00.000Z' });
  const noteEl = composition.content[0].data.items.find((item) => item.archetype_node_id === 'at0003');
  assert.deepEqual(noteEl.value, {
    _type: 'DV_CODED_TEXT',
    value: 'Test3',
    defining_code: { _type: 'CODE_PHRASE', terminology_id: { _type: 'TERMINOLOGY_ID', value: 'http://fhir.de/CodeSystem/dimdi/icd-10-gm' }, code_string: 'M10.2' },
    mappings: [{
      _type: 'TERM_MAPPING',
      match: '=',
      target: { _type: 'CODE_PHRASE', terminology_id: { _type: 'TERMINOLOGY_ID', value: 'http://fhir.de/CodeSystem/dimdi/icd-10-gm' }, code_string: 'M10.2' },
    }],
  });
});

test('codeMappings.enabled on a DV_CODED_TEXT binding falls back to plain DV_TEXT when no code has been entered yet (defining_code is RM-mandatory, cannot be fabricated)', () => {
  const codedDefinition = {
    ...definition,
    layout: {
      type: 'form',
      children: [{
        id: 'notes', type: 'input-text',
        binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0003]', rmType: 'DV_CODED_TEXT' },
        codeMappings: { enabled: true, terminologies: [{ id: 'http://fhir.de/CodeSystem/dimdi/icd-10-gm', label: 'ICD-10-GM' }] },
      }],
    },
  };
  const composition = buildCanonicalComposition(codedDefinition, {
    notes: { value: 'Nur Text, noch kein Code' },
  }, webTemplateTree, { time: '2026-08-26T10:00:00.000Z' });
  const noteEl = composition.content[0].data.items.find((item) => item.archetype_node_id === 'at0003');
  assert.deepEqual(noteEl.value, { _type: 'DV_TEXT', value: 'Nur Text, noch kein Code' });
});

test('codeMappings.enabled: an explicit match type is preserved (e.g. "?" for an approximate/unknown reference mapping)', () => {
  const codedDefinition = {
    ...definition,
    layout: {
      type: 'form',
      children: [{
        id: 'notes', type: 'input-text',
        binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0003]', rmType: 'DV_TEXT' },
        codeMappings: { enabled: true, terminologies: [{ id: 'condition.id', label: 'Case identifier', match: '?' }] },
      }],
    },
  };
  const composition = buildCanonicalComposition(codedDefinition, {
    notes: { value: '00010002218401', mappings: [{ terminologyId: 'condition.id', code: '00010002218401', match: '?' }] },
  }, webTemplateTree, { time: '2026-08-26T10:00:00.000Z' });
  const noteEl = composition.content[0].data.items.find((item) => item.archetype_node_id === 'at0003');
  assert.equal(noteEl.value.mappings[0].match, '?');
});

// RM data_types.text 5.2.2: TERM_MAPPING.match is a char restricted to
// '>'/'='/'<'/'?' - a value outside that set (nothing in this app sets one
// today, but a future form script or a UI that lets a clinician type
// something freeform could) must fall back to '=' rather than ship an
// RM-invalid TERM_MAPPING, the same way an unset match already does.
test('codeMappings.enabled: an invalid/unrecognized match value falls back to "=" rather than shipping an RM-invalid TERM_MAPPING', () => {
  const codedDefinition = {
    ...definition,
    layout: {
      type: 'form',
      children: [{
        id: 'notes', type: 'input-text',
        binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0003]', rmType: 'DV_TEXT' },
        codeMappings: { enabled: true, terminologies: [{ id: 'condition.id', label: 'Case identifier' }] },
      }],
    },
  };
  const composition = buildCanonicalComposition(codedDefinition, {
    notes: { value: '00010002218401', mappings: [{ terminologyId: 'condition.id', code: '00010002218401', match: 'equivalent' }] },
  }, webTemplateTree, { time: '2026-08-26T10:00:00.000Z' });
  const noteEl = composition.content[0].data.items.find((item) => item.archetype_node_id === 'at0003');
  assert.equal(noteEl.value.mappings[0].match, '=');
});

test('codeMappings.enabled: multiple mapping entries on the same field are all preserved, in order', () => {
  const codedDefinition = {
    ...definition,
    layout: {
      type: 'form',
      children: [{
        id: 'notes', type: 'input-text',
        binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0003]', rmType: 'DV_TEXT' },
        codeMappings: { enabled: true, allowMultiple: true, terminologies: [{ id: 'icd10gm', label: 'ICD-10-GM' }, { id: 'snomed', label: 'SNOMED CT' }] },
      }],
    },
  };
  const composition = buildCanonicalComposition(codedDefinition, {
    notes: { value: 'Diagnose', mappings: [{ terminologyId: 'icd10gm', code: 'F16.0' }, { terminologyId: 'snomed', code: '86299006' }] },
  }, webTemplateTree, { time: '2026-08-26T10:00:00.000Z' });
  const noteEl = composition.content[0].data.items.find((item) => item.archetype_node_id === 'at0003');
  assert.deepEqual(noteEl.value.mappings.map((m) => m.target.code_string), ['F16.0', '86299006']);
});

test('codeMappings.enabled: a field with no mapping entered yet stays a plain DV_TEXT with no mappings attribute at all', () => {
  const codedDefinition = {
    ...definition,
    layout: {
      type: 'form',
      children: [{
        id: 'notes', type: 'input-text',
        binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0003]', rmType: 'DV_TEXT' },
        codeMappings: { enabled: true, terminologies: [{ id: 'icd10gm', label: 'ICD-10-GM' }] },
      }],
    },
  };
  const composition = buildCanonicalComposition(codedDefinition, { notes: { value: 'Nur Text, kein Code' } }, webTemplateTree, { time: '2026-08-26T10:00:00.000Z' });
  const noteEl = composition.content[0].data.items.find((item) => item.archetype_node_id === 'at0003');
  assert.deepEqual(noteEl.value, { _type: 'DV_TEXT', value: 'Nur Text, kein Code' });
});

// allowFreeText - a DV_CODED_TEXT|DV_TEXT union field (from the OPT
// constraint model, set at import time by webTemplateParser.ts), reusing
// qualifier_category/at0007 (same node the codeMappings-override test above
// uses to reproduce "WebTemplate reports DV_CODED_TEXT"). Distinct from
// codeMappings: this is the field's OWN rmType being DV_CODED_TEXT with a
// closed options list plus a genuine free-text alternative, not a DV_TEXT
// field opted into external terminology tagging.
test('allowFreeText: a DV_CODED_TEXT field with a known option still builds a full defining_code, regardless of allowFreeText', () => {
  const freeTextDefinition = {
    ...definition,
    layout: {
      type: 'form',
      children: [{
        id: 'qualifier_category', type: 'input-select',
        binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0007]', rmType: 'DV_CODED_TEXT' },
        options: [{ value: 'at0064', text: 'Hauptdiagnose' }, { value: 'at0066', text: 'Nebendiagnose' }],
        allowFreeText: true,
      }],
    },
  };
  const composition = buildCanonicalComposition(freeTextDefinition, { qualifier_category: 'at0064' }, webTemplateTree, { time: '2026-08-26T10:00:00.000Z' });
  const el = composition.content[0].data.items.find((item) => item.archetype_node_id === 'at0007');
  assert.deepEqual(el.value, { _type: 'DV_CODED_TEXT', value: 'Hauptdiagnose', defining_code: { _type: 'CODE_PHRASE', terminology_id: { _type: 'TERMINOLOGY_ID', value: 'local' }, code_string: 'at0064' } });
});

test('allowFreeText: an unmatched value on a DV_CODED_TEXT|DV_TEXT union field serializes as plain DV_TEXT, never a bogus defining_code', () => {
  const freeTextDefinition = {
    ...definition,
    layout: {
      type: 'form',
      children: [{
        id: 'qualifier_category', type: 'input-select',
        binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0007]', rmType: 'DV_CODED_TEXT' },
        options: [{ value: 'at0064', text: 'Hauptdiagnose' }, { value: 'at0066', text: 'Nebendiagnose' }],
        allowFreeText: true,
      }],
    },
  };
  const composition = buildCanonicalComposition(freeTextDefinition, { qualifier_category: 'Sonderfall, nicht in der Liste' }, webTemplateTree, { time: '2026-08-26T10:00:00.000Z' });
  const el = composition.content[0].data.items.find((item) => item.archetype_node_id === 'at0007');
  assert.deepEqual(el.value, { _type: 'DV_TEXT', value: 'Sonderfall, nicht in der Liste' });
});

test('allowFreeText: without the flag (every existing form), an unmatched value still gets forced into a bogus defining_code - unchanged legacy behavior', () => {
  const strictDefinition = {
    ...definition,
    layout: {
      type: 'form',
      children: [{
        id: 'qualifier_category', type: 'input-select',
        binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0007]', rmType: 'DV_CODED_TEXT' },
        options: [{ value: 'at0064', text: 'Hauptdiagnose' }],
      }],
    },
  };
  const composition = buildCanonicalComposition(strictDefinition, { qualifier_category: 'not-a-real-code' }, webTemplateTree, { time: '2026-08-26T10:00:00.000Z' });
  const el = composition.content[0].data.items.find((item) => item.archetype_node_id === 'at0007');
  assert.equal(el.value._type, 'DV_CODED_TEXT');
  assert.equal(el.value.defining_code.code_string, 'not-a-real-code');
});

// Regression: live 400 from EHRbase - "Invariant Inv_null_flavour_indicated
// failed on type ELEMENT" on the *second* occurrence of a union-typed
// slot's archetype_node_id (vg_ObservationLab.v1.2.0's "Analyte result"/
// at0001, inside CLUSTER.laboratory_test_analyte.v1). Root cause:
// buildStructuralChildren/buildEntryData walked every WebTemplate child
// node independently - for a polymorphic slot with three sibling nodes
// (one per DV_QUANTITY/DV_TEXT/DV_CODED_TEXT alternative, all sharing the
// same aqlPath), buildNode's leaf branch resolved ALL THREE to the SAME
// field (the one with an actual value) but serialized each using ITS OWN
// node's concrete rmType - producing three ELEMENTs at the identical
// archetype_node_id, only one of them (the alternative matching the
// field's real value) valid. This only ever surfaced once a form with this
// exact archetype shape (a union slot inside a CLUSTER) also had
// codeMappings enabled somewhere on it, which routes submission through
// this canonical builder instead of the FLAT path that never had the bug.
test('a polymorphic RM slot (three sibling WebTemplate nodes sharing one aqlPath, DV_QUANTITY/DV_TEXT/DV_CODED_TEXT) inside a CLUSTER builds exactly one ELEMENT, not one per alternative', () => {
  const unionTree = {
    id: 'obs', name: 'ObsLab', rmType: 'COMPOSITION', nodeId: 'openEHR-EHR-COMPOSITION.report.v1',
    children: [{
      id: 'entry', name: 'Entry', rmType: 'ADMIN_ENTRY', min: 0, max: 1, nodeId: 'openEHR-EHR-ADMIN_ENTRY.vitals.v1', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]',
      children: [{
        id: 'analyte', name: 'Analyte', rmType: 'CLUSTER', min: 0, max: -1, nodeId: 'at0004', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0004]',
        children: [
          // Three alternative representations of the same "Analyte result"
          // slot, all sharing the identical aqlPath/archetypeNodeId -
          // exactly how vg_ObservationLab.v1.2.0's real WebTemplate reports
          // at0001 (confirmed live).
          { id: 'quantity_value', name: 'Analyte result', rmType: 'DV_QUANTITY', min: 0, max: 1, nodeId: 'at0001', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0004]/items[at0001]' },
          { id: 'text_value', name: 'Analyte result', rmType: 'DV_TEXT', min: 0, max: 1, nodeId: 'at0001', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0004]/items[at0001]' },
          { id: 'coded_text_value', name: 'Analyte result', rmType: 'DV_CODED_TEXT', min: 0, max: 1, nodeId: 'at0001', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0004]/items[at0001]' },
        ],
      }],
    }],
  };
  const unionDefinition = {
    id: 'obs-form', name: 'ObsLab', version: '1.0.0',
    sourceTemplates: [{ alias: 'obs', id: 'obs.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    locales: { en: {} },
    layout: {
      type: 'form',
      children: [
        { id: 'quantity_value', type: 'input-quantity', binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0004]/items[at0001]', rmType: 'DV_QUANTITY' } },
        // A codeMappings field ANYWHERE on the form is what routes this
        // through buildCanonicalComposition at all in the real app - not
        // exercised by buildCanonicalComposition itself (it's always used
        // here), but kept as a field to document why this shape matters.
        { id: 'diagnostic_service_category', type: 'input-text', binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0003]', rmType: 'DV_TEXT' }, codeMappings: { enabled: true, terminologies: [{ id: 'http://loinc.org', label: 'Category' }] } },
      ],
    },
  };
  const composition = buildCanonicalComposition(unionDefinition, {
    quantity_value: { magnitude: 3.2, unit: '10^9/L' },
    diagnostic_service_category: { value: 'Laboratory', mappings: [{ terminologyId: 'http://loinc.org', code: '26436-6' }] },
  }, unionTree, { time: '2026-08-26T10:00:00.000Z' });

  const cluster = composition.content[0].data.items.find((item) => item.archetype_node_id === 'at0004');
  const resultEls = cluster.items.filter((item) => item.archetype_node_id === 'at0001');
  assert.equal(resultEls.length, 1);
  assert.deepEqual(resultEls[0].value, { _type: 'DV_QUANTITY', magnitude: 3.2, units: '10^9/L' });
});

// Regression: live 400 from EHRbase - "Invariant Inv_null_flavour_indicated
// failed on type ELEMENT" on vg_ObservationLab.v1.2.0's "Analyte result"
// (at0001, inside CLUSTER.laboratory_test_analyte.v1). Root cause: a
// polymorphic/union RM slot's REAL WebTemplate shape (confirmed live via
// get_remote_template_detail) is a WRAPPER node (rmType 'ELEMENT', aqlPath
// ending `items[at0001]`, no `/value`) whose CHILDREN are the concrete-type
// alternatives (DV_QUANTITY/DV_TEXT/DV_CODED_TEXT, each aqlPath ending
// `items[at0001]/value` - one level deeper than the wrapper, which is what
// every real field binding actually targets). buildNode's leaf branch only
// ever checked the CURRENT node's own aqlPath, so it never matched the
// wrapper, fell through to the generic `default:` structural case, and
// wrapped whichever child resolved inside a SECOND, invalid "ELEMENT" that
// carries an `items` array instead of a `value` attribute - which is
// exactly what the null-flavour invariant polices (that outer shell
// genuinely has no `value` at all). The (much rarer) case with two
// FLAT sibling nodes sharing one aqlPath is the OTHER regression test above
// ("three sibling WebTemplate nodes") - this one reproduces the real,
// live-confirmed nested-wrapper shape specifically.
test('a polymorphic RM slot shaped as a wrapper ELEMENT node with concrete-type children one level deeper (the real vg_ObservationLab.v1.2.0 shape) builds one valid ELEMENT with a real `value`, not a nested shell', () => {
  const wrapperTree = {
    id: 'obs', name: 'ObsLab', rmType: 'COMPOSITION', nodeId: 'openEHR-EHR-COMPOSITION.report.v1',
    children: [{
      id: 'entry', name: 'Entry', rmType: 'ADMIN_ENTRY', min: 0, max: 1, nodeId: 'openEHR-EHR-ADMIN_ENTRY.vitals.v1', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]',
      children: [{
        id: 'analyte', name: 'Analyte', rmType: 'CLUSTER', min: 0, max: -1, nodeId: 'at0004', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0004]',
        children: [{
          // The wrapper itself - rmType 'ELEMENT', its OWN aqlPath has no
          // `/value` suffix and no field is ever bound to it directly.
          id: 'analyte_result', name: 'Analyte result', rmType: 'ELEMENT', min: 0, max: -1, nodeId: 'at0001',
          aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0004]/items[at0001]',
          children: [
            { id: 'quantity_value', name: 'Analyte result', rmType: 'DV_QUANTITY', min: 1, max: 1, nodeId: 'at0001', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0004]/items[at0001]/value' },
            { id: 'text_value', name: 'Analyte result', rmType: 'DV_TEXT', min: 1, max: 1, nodeId: 'at0001', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0004]/items[at0001]/value' },
            { id: 'coded_text_value', name: 'Analyte result', rmType: 'DV_CODED_TEXT', min: 1, max: 1, nodeId: 'at0001', aqlPath: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0004]/items[at0001]/value' },
          ],
        }],
      }],
    }],
  };
  const wrapperDefinition = {
    id: 'obs-form', name: 'ObsLab', version: '1.0.0',
    sourceTemplates: [{ alias: 'obs', id: 'obs.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    locales: { en: {} },
    layout: {
      type: 'form',
      children: [
        { id: 'quantity_value', type: 'input-quantity', binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0004]/items[at0001]/value', rmType: 'DV_QUANTITY' } },
        // codeMappings anywhere on the form is what routes real submissions
        // through this builder at all - not exercised directly here (the
        // builder is always used in this test file), kept to document why.
        { id: 'diagnostic_service_category', type: 'input-text', binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0003]', rmType: 'DV_TEXT' }, codeMappings: { enabled: true, terminologies: [{ id: 'http://loinc.org', label: 'Category' }] } },
      ],
    },
  };
  const composition = buildCanonicalComposition(wrapperDefinition, {
    quantity_value: { magnitude: 3.2, unit: '10^9/L' },
    diagnostic_service_category: { value: 'Laboratory', mappings: [{ terminologyId: 'http://loinc.org', code: '26436-6' }] },
  }, wrapperTree, { time: '2026-08-26T10:00:00.000Z' });

  const cluster = composition.content[0].data.items.find((item) => item.archetype_node_id === 'at0004');
  const resultEls = cluster.items.filter((item) => item.archetype_node_id === 'at0001');
  assert.equal(resultEls.length, 1);
  const resultEl = resultEls[0];
  assert.equal(resultEl._type, 'ELEMENT');
  // The real bug: the built node had no `value` at all (an `items` array
  // instead), which is exactly what Inv_null_flavour_indicated polices.
  assert.equal('items' in resultEl, false);
  assert.deepEqual(resultEl.value, { _type: 'DV_QUANTITY', magnitude: 3.2, units: '10^9/L' });
});

test('a coded option with a distinct rmValue serializes the RM value (archetype original-language term text), not the German display text - see coded-text-rmvalue.test.js for the live bug', () => {
  const germanFirstDefinition = {
    ...definition,
    layout: {
      type: 'form',
      children: [{
        id: 'qualifier_category', type: 'input-select',
        binding: { path: '/content[openEHR-EHR-ADMIN_ENTRY.vitals.v1]/data[at0001]/items[at0007]', rmType: 'DV_CODED_TEXT' },
        options: [{ value: 'at0064', text: 'Vermutet', rmValue: 'Suspected' }],
      }],
    },
  };
  const composition = buildCanonicalComposition(germanFirstDefinition, { qualifier_category: 'at0064' }, webTemplateTree, { time: '2026-08-26T10:00:00.000Z' });
  const el = composition.content[0].data.items.find((item) => item.archetype_node_id === 'at0007');
  assert.equal(el.value.value, 'Suspected');
});

test('INSTRUCTION.protocol is built and attached, not silently dropped (same gap as OBSERVATION/ACTION.protocol)', () => {
  // Confirmed live (vg_ServiceRequest.v1.1.1): "Status der Anfrage"/at0127
  // binds under /protocol[at0008]/items[at0127]/value directly off the
  // INSTRUCTION content node (a sibling of `activities`, not nested under
  // the ACTIVITY) - same missing-`protocol`-attribute gap as OBSERVATION and
  // ACTION, just on INSTRUCTION's own switch case.
  const tree = {
    id: 'sr', name: 'ServiceRequest', rmType: 'COMPOSITION', nodeId: 'openEHR-EHR-COMPOSITION.report.v1',
    children: [{
      id: 'service_request', name: 'Service request', rmType: 'INSTRUCTION', min: 0, max: 1,
      nodeId: 'openEHR-EHR-INSTRUCTION.service_request.v1', aqlPath: '/content[openEHR-EHR-INSTRUCTION.service_request.v1]',
      children: [
        {
          id: 'activity', name: 'Activity', rmType: 'ACTIVITY', min: 1, max: 1, nodeId: 'at0001',
          aqlPath: '/content[openEHR-EHR-INSTRUCTION.service_request.v1]/activities[at0001]',
          children: [{
            id: 'description', name: 'Description', rmType: 'ITEM_TREE', min: 1, max: 1, nodeId: 'at0009',
            aqlPath: '/content[openEHR-EHR-INSTRUCTION.service_request.v1]/activities[at0001]/description[at0009]',
            children: [{ id: 'service_name', name: 'Service name', rmType: 'DV_TEXT', min: 1, max: 1, nodeId: 'at0121', aqlPath: '/content[openEHR-EHR-INSTRUCTION.service_request.v1]/activities[at0001]/description[at0009]/items[at0121]/value' }],
          }],
        },
        { id: 'request_status', name: 'Status der Anfrage', rmType: 'DV_TEXT', min: 0, max: 1, nodeId: 'at0127', aqlPath: '/content[openEHR-EHR-INSTRUCTION.service_request.v1]/protocol[at0008]/items[at0127]/value' },
      ],
    }],
  };
  const definition = {
    id: 'sr-form', name: 'ServiceRequest', version: '1.0.0',
    sourceTemplates: [{ alias: 'sr', id: 'sr.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    locales: { en: {} }, bindings: {},
    layout: {
      type: 'form',
      children: [
        { id: 'service_name', type: 'input-text', binding: { path: '/content[openEHR-EHR-INSTRUCTION.service_request.v1]/activities[at0001]/description[at0009]/items[at0121]/value', rmType: 'DV_TEXT' } },
        { id: 'request_status', type: 'input-text', binding: { path: '/content[openEHR-EHR-INSTRUCTION.service_request.v1]/protocol[at0008]/items[at0127]/value', rmType: 'DV_TEXT' } },
      ],
    },
  };
  const composition = buildCanonicalComposition(definition, { service_name: 'Röntgen Thorax', request_status: 'Active' }, tree, { time: '2026-08-26T10:00:00.000Z' });
  const instruction = composition.content[0];
  assert.ok(instruction.protocol, 'INSTRUCTION.protocol must be present when a protocol-bound field has a value');
  assert.equal(instruction.protocol._type, 'ITEM_TREE');
  assert.equal(instruction.protocol.archetype_node_id, 'at0008');
  assert.equal(instruction.protocol.items[0].value.value, 'Active');
  // RM-mandatory (1..1) and never form-editable - EHRbase rejects a
  // structured ACTIVITY with no action_archetype_id at all ("does not match
  // existence 1..1"), confirmed live for this exact template.
  assert.equal(instruction.activities[0].action_archetype_id, '.*');
});

test('EVENT_CONTEXT.start_time uses a bound field\'s real value when the form provides one, not always "now" (same fixed-attribute gap as ACTION.time)', () => {
  // Confirmed live (vg_ServiceRequest.v1.1.1): the HIP mapping targets
  // /context/start_time directly from FHIR authoredOn.
  const composition = buildCanonicalComposition(
    { ...definition, layout: { type: 'form', children: [{ id: 'start_time', type: 'input-date-time', binding: { path: '/context/start_time', rmType: 'DV_DATE_TIME' } }] } },
    { start_time: '2026-05-15T09:00:00Z' },
    webTemplateTree,
    { time: '2026-08-26T10:00:00.000Z' }, // the fallback default - must NOT win when a real field value exists
  );
  assert.equal(composition.context.start_time.value, '2026-05-15T09:00:00Z');

  // And the pre-existing "now" fallback still applies when no such field is bound at all (backward compatible).
  const fallback = buildCanonicalComposition(definition, {}, webTemplateTree, { time: '2026-08-26T10:00:00.000Z' });
  assert.equal(fallback.context.start_time.value, '2026-08-26T10:00:00.000Z');
});
