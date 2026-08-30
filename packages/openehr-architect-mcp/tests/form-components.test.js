import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveDocumentComponents } from '../dist/documentTemplate/formComponents.js';
import { ComponentResolutionError } from '../dist/documentTemplate/types.js';

test('a single-archetype form yields exactly one DocumentComponent, labeled with the form\'s own name by default', () => {
  const form = {
    name: 'Diagnosen / Vorerkrankungen',
    sourceTemplates: [{ id: 'vg_Diagnosis.v1.1.1' }],
    bindings: {
      'vg_diagnosis.v1.1.1_problem_diagnosis_name': { openehr: { archetypeId: 'openEHR-EHR-EVALUATION.problem_diagnosis.v1', path: "/content[openEHR-EHR-EVALUATION.problem_diagnosis.v1 and name/value='primary diagnosis']/data[at0001]/items[at0002]/value" } },
      'vg_diagnosis.v1.1.1_severity': { openehr: { archetypeId: 'openEHR-EHR-EVALUATION.problem_diagnosis.v1', path: "/content[openEHR-EHR-EVALUATION.problem_diagnosis.v1 and name/value='primary diagnosis']/data[at0001]/items[at0005]/value" } },
    },
  };

  const components = deriveDocumentComponents(form);

  assert.equal(components.length, 1);
  assert.deepEqual(components[0], {
    sourceTemplateId: 'vg_Diagnosis.v1.1.1',
    sourceArchetypeId: 'openEHR-EHR-EVALUATION.problem_diagnosis.v1',
    sourceName: 'primary diagnosis',
    label: 'Diagnosen / Vorerkrankungen',
    wrapInSection: true,
  });
});

test('a form binding more than one archetype yields one component per archetype, each with a distinguishing label (regression: same-label wrapper collision)', () => {
  // Mirrors the real "Entlassungsbrief-Zusammenfassung" form, which binds
  // both EVALUATION.clinical_synopsis.v1 and EVALUATION.recommendation.v2.
  const form = {
    name: 'Entlassungsbrief-Zusammenfassung',
    sourceTemplates: [{ id: 'vg_entlassungsbrief.0.1.0' }],
    bindings: {
      synopsis: { openehr: { archetypeId: 'openEHR-EHR-EVALUATION.clinical_synopsis.v1', path: '/content[openEHR-EHR-EVALUATION.clinical_synopsis.v1]/data[at0001]/items[at0002]/value' } },
      recommendation: { openehr: { archetypeId: 'openEHR-EHR-EVALUATION.recommendation.v2', path: '/content[openEHR-EHR-EVALUATION.recommendation.v2]/data[at0001]/items[at0002]/value' } },
    },
  };

  const components = deriveDocumentComponents(form);

  assert.equal(components.length, 2);
  const labels = components.map((c) => c.label);
  assert.deepEqual(new Set(labels).size, 2, `labels must be distinct to avoid the wrapper-SECTION collision, got ${JSON.stringify(labels)}`);
  assert.ok(labels.every((l) => l.startsWith('Entlassungsbrief-Zusammenfassung')));
  assert.deepEqual(new Set(components.map((c) => c.sourceArchetypeId)), new Set(['openEHR-EHR-EVALUATION.clinical_synopsis.v1', 'openEHR-EHR-EVALUATION.recommendation.v2']));
});

test('the same archetype bound twice under different name-qualifiers yields two distinct components, each carrying its own sourceName', () => {
  const form = {
    name: 'Diagnosen (primär + sekundär)',
    sourceTemplates: [{ id: 'vg_Diagnosis.v1.1.1' }],
    bindings: {
      primary_name: { openehr: { archetypeId: 'openEHR-EHR-EVALUATION.problem_diagnosis.v1', path: "/content[openEHR-EHR-EVALUATION.problem_diagnosis.v1 and name/value='primary diagnosis']/data[at0001]/items[at0002]/value" } },
      secondary_name: { openehr: { archetypeId: 'openEHR-EHR-EVALUATION.problem_diagnosis.v1', path: "/content[openEHR-EHR-EVALUATION.problem_diagnosis.v1 and name/value='secondary diagnosis']/data[at0001]/items[at0002]/value" } },
    },
  };

  const components = deriveDocumentComponents(form);

  assert.equal(components.length, 2);
  assert.deepEqual(new Set(components.map((c) => c.sourceName)), new Set(['primary diagnosis', 'secondary diagnosis']));
});

test('label/wrapInSection overrides are honored and applied to every derived component', () => {
  const form = {
    name: 'Diagnostik-Befund',
    sourceTemplates: [{ id: 'vg_diagnostikbefund.0.1.0' }],
    bindings: {
      study_name: { openehr: { archetypeId: 'openEHR-EHR-OBSERVATION.imaging_exam_result.v1', path: '/content[openEHR-EHR-OBSERVATION.imaging_exam_result.v1]/data[at0001]/events[at0002]/data[at0003]/items[at0004]/value' } },
    },
  };

  const components = deriveDocumentComponents(form, { label: 'Kontroll-Mammographie', wrapInSection: false });

  assert.equal(components[0].label, 'Kontroll-Mammographie');
  assert.equal(components[0].wrapInSection, false);
});

test('rejects a form with other than exactly one sourceTemplates entry instead of silently picking the first', () => {
  const noTemplates = { name: 'Broken', sourceTemplates: [], bindings: {} };
  const twoTemplates = { name: 'Broken', sourceTemplates: [{ id: 'a' }, { id: 'b' }], bindings: {} };

  assert.throws(() => deriveDocumentComponents(noTemplates), ComponentResolutionError);
  assert.throws(() => deriveDocumentComponents(twoTemplates), ComponentResolutionError);
});

test('rejects a form with no archetype-bound bindings at all', () => {
  const form = { name: 'Empty', sourceTemplates: [{ id: 'x' }], bindings: {} };
  assert.throws(() => deriveDocumentComponents(form), ComponentResolutionError);
});
