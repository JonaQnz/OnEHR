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

function findAllNodes(node, predicate, out = []) {
  if (predicate(node)) out.push(node);
  for (const child of node.children || []) findAllNodes(child, predicate, out);
  return out;
}

// Regression test: a composed multi-section document (see
// compose_document_template) commonly reuses two different archetypes that
// each happen to have their own leaf/container with the same short
// technical id (e.g. both a Diagnosen and a Medikation branch have their
// own "comment" element; two different sections could both contain their
// own "clinical_synopsis" EVALUATION). Before this fix, buildLayoutNode gave
// every leaf/container `id: node.id` verbatim with no disambiguation - only
// the separately-computed `name`/fieldName was unique - so two such leaves
// silently shared one runtime values key (confirmed live: typing into one
// "Comment" box changed both). Both `id` and `name` must now agree on the
// same disambiguation.
function composedTwoSectionTemplate() {
  return {
    templateId: 'composed_doc.v1',
    tree: {
      id: 'composed_doc', rmType: 'COMPOSITION', aqlPath: '',
      children: [
        {
          id: 'diagnosen', name: 'Diagnosen', rmType: 'SECTION',
          aqlPath: "/content[openEHR-EHR-SECTION.adhoc.v1 and name/value='Diagnosen']",
          children: [{
            id: 'primary_diagnosis', name: 'primary diagnosis', rmType: 'EVALUATION',
            aqlPath: "/content[openEHR-EHR-SECTION.adhoc.v1 and name/value='Diagnosen']/items[openEHR-EHR-EVALUATION.problem_diagnosis.v1]",
            children: [{
              id: 'data', rmType: 'ITEM_TREE',
              aqlPath: "/content[.../Diagnosen']/items[openEHR-EHR-EVALUATION.problem_diagnosis.v1]/data[at0001]",
              children: [
                { id: 'comment', name: 'Comment', rmType: 'DV_TEXT', aqlPath: '.../items[at0069]' },
              ],
            }],
          }],
        },
        {
          id: 'verlauf', name: 'Verlauf', rmType: 'SECTION',
          aqlPath: "/content[openEHR-EHR-SECTION.adhoc.v1 and name/value='Verlauf']",
          children: [{
            id: 'clinical_synopsis', name: 'Clinical Synopsis', rmType: 'EVALUATION',
            aqlPath: "/content[openEHR-EHR-SECTION.adhoc.v1 and name/value='Verlauf']/items[openEHR-EHR-EVALUATION.clinical_synopsis.v1]",
            children: [{
              id: 'data', rmType: 'ITEM_TREE',
              aqlPath: "/content[.../Verlauf']/items[openEHR-EHR-EVALUATION.clinical_synopsis.v1]/data[at0001]",
              children: [
                { id: 'comment', name: 'Comment', rmType: 'DV_TEXT', aqlPath: '.../items[at0099]' },
              ],
            }],
          }],
        },
      ],
    },
  };
}

test('leaf ids are disambiguated across archetype branches - two unrelated "comment" fields no longer collide on one runtime values key', () => {
  const result = parseWebTemplate(composedTwoSectionTemplate());

  const commentLeaves = findAllNodes(result.layout, (node) => typeof node.id === 'string' && node.id.startsWith('comment') && node.type?.startsWith('input'));
  assert.equal(commentLeaves.length, 2, 'both comment fields survive parsing');
  const ids = commentLeaves.map((leaf) => leaf.id);
  assert.deepEqual(new Set(ids).size, 2, `leaf ids must be distinct, got ${JSON.stringify(ids)}`);

  // id and name stay consistent (same disambiguation, same source of truth)
  for (const leaf of commentLeaves) {
    const suffix = leaf.id === 'comment' ? '' : leaf.id.replace('comment', '');
    assert.ok(leaf.name.endsWith(`comment${suffix}`), `name "${leaf.name}" should end with the same suffix as id "${leaf.id}"`);
  }
});

test('container ids are disambiguated too - two different sections each containing their own "clinical_synopsis" EVALUATION no longer share one runtime group id', () => {
  // Two SECTIONs, each independently wrapping an EVALUATION whose own
  // technical id happens to be "clinical_synopsis" (exactly the shape
  // compose_document_template produces when the same generic Synopsis
  // component is used twice in one composed document, e.g. once for
  // "Response-Beurteilung" and once for "Postoperativer Pathologiebefund").
  const template = {
    templateId: 'composed_doc.v2',
    tree: {
      id: 'composed_doc', rmType: 'COMPOSITION', aqlPath: '',
      children: [
        {
          id: 'response', name: 'Response-Beurteilung', rmType: 'SECTION',
          aqlPath: "/content[openEHR-EHR-SECTION.adhoc.v1 and name/value='Response-Beurteilung']",
          children: [{
            id: 'clinical_synopsis', name: 'Clinical Synopsis', rmType: 'EVALUATION',
            aqlPath: "/content[.../Response-Beurteilung']/items[openEHR-EHR-EVALUATION.clinical_synopsis.v1]",
            children: [{
              id: 'data', rmType: 'ITEM_TREE', aqlPath: '.../data[at0001]',
              children: [{ id: 'synopsis', name: 'Synopsis', rmType: 'DV_TEXT', min: 1, aqlPath: '.../items[at0002]' }],
            }],
          }],
        },
        {
          id: 'pathologie', name: 'Postoperativer Pathologiebefund', rmType: 'SECTION',
          aqlPath: "/content[openEHR-EHR-SECTION.adhoc.v1 and name/value='Postoperativer Pathologiebefund']",
          children: [{
            id: 'clinical_synopsis', name: 'Clinical Synopsis', rmType: 'EVALUATION',
            aqlPath: "/content[.../Postoperativer Pathologiebefund']/items[openEHR-EHR-EVALUATION.clinical_synopsis.v1]",
            children: [{
              id: 'data', rmType: 'ITEM_TREE', aqlPath: '.../data[at0001]',
              children: [{ id: 'synopsis', name: 'Synopsis', rmType: 'DV_TEXT', min: 1, aqlPath: '.../items[at0002]' }],
            }],
          }],
        },
      ],
    },
  };

  const result = parseWebTemplate(template);
  const synopsisContainers = findAllNodes(result.layout, (node) => typeof node.id === 'string' && node.id.startsWith('clinical_synopsis') && node.type === 'container');
  assert.equal(synopsisContainers.length, 2, 'both clinical_synopsis containers survive parsing');
  const ids = synopsisContainers.map((c) => c.id);
  assert.deepEqual(new Set(ids).size, 2, `container ids must be distinct, got ${JSON.stringify(ids)}`);

  // Each still resolves to its own two "synopsis" leaves underneath, distinct.
  const synopsisLeaves = findAllNodes(result.layout, (node) => typeof node.id === 'string' && node.id.startsWith('synopsis') && node.type?.startsWith('input'));
  assert.equal(synopsisLeaves.length, 2);
  assert.deepEqual(new Set(synopsisLeaves.map((l) => l.id)).size, 2);
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

// Test 8 - the flat, hand-curated field-picking path (no `layout` passed -
// this is what apply_template_to_form/generate_form_from_template actually
// use when building a Form Section from a subset of a template's fields)
// must not silently flatten a field whose template ancestor repeats. The
// parser already marks such fields `parentRepeatable` (Test 3/4's own
// fixture proves the EVENT itself is repeatable); the generator has to act
// on that flag, not just carry it.
test('generateCanonicalForm groups fields from a repeatable template ancestor into one repeatable container', () => {
  const parsed = parseWebTemplate(bloodPressureTemplate());
  const systolic = parsed.fields.find((field) => field.technicalName === 'systolic');
  assert.equal(systolic.parentRepeatable, true, 'the parser marks a field under a repeatable EVENT');
  assert.equal(systolic.parentRepeatMax, -1);

  const generated = generateCanonicalForm({
    name: 'Blood Pressure', templateId: parsed.templateId, alias: parsed.alias,
    fields: [systolic], id: 'form-flat',
  });

  const group = findNode(generated.layout, (node) => node.repeatable === true);
  assert.ok(group, 'a repeatable container was generated for the picked field');
  assert.equal(group.repeatMax, -1);
  const leaf = findNode(group, (node) => node.name === systolic.fieldName);
  assert.ok(leaf, 'the picked field lives inside the repeatable container, not flattened alongside it');
});

// A field with no repeatable ancestor keeps the original flat shape - one
// row per field, no repeatable container at all - so ordinary (the vast
// majority of) Form Sections are completely unaffected by this change.
test('generateCanonicalForm leaves non-repeatable fields as flat rows, unchanged', () => {
  const generated = generateCanonicalForm({
    name: 'Plain', templateId: 'tmpl', alias: 'tmpl',
    fields: [{ fieldName: 'tmpl_note', label: 'Note', templateAlias: 'tmpl', templateId: 'tmpl', rmType: 'DV_TEXT', dataType: 'text', openehrPath: '/note', required: false }],
    id: 'form-flat-2',
  });
  assert.equal(findNode(generated.layout, (node) => node.repeatable === true), undefined);
  assert.ok(findNode(generated.layout, (node) => node.name === 'tmpl_note'));
});

// Regression: traverseFlat's parentRepeat tracking used to check
// isClusterLikeNode() only (CLUSTER/EVENT/ACTIVITY) - buildLayoutNode's own
// isEntryNode() branch (OBSERVATION/EVALUATION/INSTRUCTION/ACTION/
// ADMIN_ENTRY) independently produces a `repeatable: true` layout container
// for a repeating ENTRY too (e.g. vg_Diagnosis.v1.1.1's repeatable
// secondary-diagnosis EVALUATION), so the two passes silently disagreed:
// the layout tree correctly showed a repeatable group, but every field
// inside it still carried parentRepeatable === undefined in the flat
// registry - wrong metadata for the Developer Inspector and for
// generateCanonicalForm's own repeatable-ancestor grouping (Test 8 above),
// which reads exactly this flag.
function repeatableEvaluationTemplate() {
  return {
    templateId: 'vg_Diagnosis.v1.1.1',
    tree: {
      id: 'diagnosis', rmType: 'COMPOSITION', aqlPath: '',
      children: [{
        id: 'secondary_diagnosis', name: 'Secondary diagnosis', rmType: 'EVALUATION', min: 0, max: -1,
        aqlPath: "/content[openEHR-EHR-EVALUATION.problem_diagnosis.v1 and name/value='secondary diagnosis']",
        children: [{
          id: 'data', rmType: 'ITEM_TREE', aqlPath: "/content[openEHR-EHR-EVALUATION.problem_diagnosis.v1 and name/value='secondary diagnosis']/data[at0001]",
          children: [{
            id: 'problem_diagnosis_name', name: 'Problem/diagnosis name', rmType: 'DV_TEXT', min: 1,
            aqlPath: "/content[openEHR-EHR-EVALUATION.problem_diagnosis.v1 and name/value='secondary diagnosis']/data[at0001]/items[at0002]",
          }],
        }],
      }],
    },
  };
}

test('parser marks a field under a repeatable ENTRY (EVALUATION/OBSERVATION/...) as parentRepeatable, not just under a repeatable CLUSTER/EVENT', () => {
  const result = parseWebTemplate(repeatableEvaluationTemplate());
  const name = result.fields.find((field) => field.technicalName === 'problem_diagnosis_name');
  assert.ok(name, 'the leaf field is present in the flat registry');
  assert.equal(name.parentRepeatable, true, 'the field must inherit its repeatable ENTRY ancestor');
  assert.equal(name.parentRepeatMin, 0);
  assert.equal(name.parentRepeatMax, -1);

  // And the layout tree (built independently by buildLayoutNode) agrees -
  // this is the invariant that broke before the fix.
  const evaluation = findNode(result.layout, (node) => node.repeatable === true);
  assert.ok(evaluation, 'the repeatable EVALUATION survives into the layout');
  assert.equal(evaluation.binding?.rmType, 'EVALUATION');
});

test('generateCanonicalForm groups a field from a repeatable EVALUATION ancestor into one repeatable container, same as a repeatable EVENT', () => {
  const parsed = parseWebTemplate(repeatableEvaluationTemplate());
  const name = parsed.fields.find((field) => field.technicalName === 'problem_diagnosis_name');
  assert.equal(name.parentRepeatable, true);

  const generated = generateCanonicalForm({
    name: 'Nebendiagnose', templateId: parsed.templateId, alias: parsed.alias,
    fields: [name], id: 'form-flat-3',
  });
  const group = findNode(generated.layout, (node) => node.repeatable === true);
  assert.ok(group, 'a repeatable container was generated for the picked field');
  assert.equal(group.repeatMax, -1);
});
