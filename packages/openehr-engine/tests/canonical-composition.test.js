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
