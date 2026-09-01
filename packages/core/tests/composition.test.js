const test = require('node:test');
const assert = require('node:assert/strict');
const {
  COMPOSITION_SCHEMA_VERSION,
  createEmptyCompositionScript,
  generateCompositionScriptTypes,
  insertCompositionBlock,
  moveCompositionBlock,
  normalizeCompositionDefinition,
  summarizeCompositionSession,
} = require('../dist');

test('normalizes a multi-page composition with forms and EHRbase data blocks', () => {
  const composition = normalizeCompositionDefinition({
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    pages: [
      { id: 'overview', title: 'Übersicht', blocks: [
        { id: 'person', type: 'form', formId: 'person-form', mode: 'edit', load: 'provider', hiddenFieldIds: ['internal-note'], fieldLabelOverrides: { first_name: 'Vorname des Kindes' } },
        { id: 'labs', type: 'data', title: 'Letzte Laborwerte', aqlFunctionId: 'lab-query', display: 'trend', valueColumn: 'value', timeColumn: 'time', limit: 12 },
      ] },
      { id: 'notes', title: 'Notizen', blocks: [{ id: 'note', type: 'text', content: 'Bitte Befund prüfen.' }] },
    ],
  });
  assert.equal(composition.pages.length, 2);
  assert.equal(composition.pages[0].blocks[0].type, 'form');
  assert.deepEqual(composition.pages[0].blocks[0].hiddenFieldIds, ['internal-note']);
  assert.deepEqual(composition.pages[0].blocks[0].fieldLabelOverrides, { first_name: 'Vorname des Kindes' });
});

test('data block limit accepts up to 1000 and rejects 1001 or 0', () => {
  const buildComposition = (limit) => ({
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    pages: [{ id: 'overview', title: 'Übersicht', blocks: [
      { id: 'labs', type: 'data', title: 'Laborwerte', aqlFunctionId: 'lab-query', display: 'trend', valueColumn: 'value', timeColumn: 'time', limit },
    ] }],
  });

  const atMax = normalizeCompositionDefinition(buildComposition(1000));
  assert.equal(atMax.pages[0].blocks[0].limit, 1000);

  assert.throws(() => normalizeCompositionDefinition(buildComposition(1001)), /limit must be between 1 and 1000/);
  assert.throws(() => normalizeCompositionDefinition(buildComposition(0)), /limit must be between 1 and 1000/);
});

test('fieldLabelOverrides is optional, trims blank entries, and rejects non-string values', () => {
  const withoutOverrides = normalizeCompositionDefinition({
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    pages: [{ id: 'overview', title: 'Übersicht', blocks: [{ id: 'person', type: 'form', formId: 'person-form' }] }],
  });
  assert.equal(withoutOverrides.pages[0].blocks[0].fieldLabelOverrides, undefined);

  const withBlankEntry = normalizeCompositionDefinition({
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    pages: [{ id: 'overview', title: 'Übersicht', blocks: [{ id: 'person', type: 'form', formId: 'person-form', fieldLabelOverrides: { note: '  ', name: '  Vorname  ' } }] }],
  });
  assert.deepEqual(withBlankEntry.pages[0].blocks[0].fieldLabelOverrides, { name: 'Vorname' });

  assert.throws(() => normalizeCompositionDefinition({
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    pages: [{ id: 'overview', title: 'Übersicht', blocks: [{ id: 'person', type: 'form', formId: 'person-form', fieldLabelOverrides: { note: 42 } }] }],
  }), /fieldLabelOverrides/);
});

test('persists explicitly enabled widget packages and preserves their named mappings', () => {
  const composition = normalizeCompositionDefinition({
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    widgetPackageIds: ['org.vita.labs:results'],
    pages: [{ id: 'overview', title: 'Overview', blocks: [{
      id: 'potassium-trend', type: 'data', title: 'Potassium',
      widgetPackageId: 'org.vita.labs:results', aqlFunctionId: 'aql-potassium',
      display: 'trend', valueColumn: 'value', timeColumn: 'sampled_at',
    }] }],
  });
  assert.deepEqual(composition.widgetPackageIds, ['org.vita.labs:results']);
  assert.equal(composition.pages[0].blocks[0].widgetPackageId, 'org.vita.labs:results');
  assert.equal(composition.pages[0].blocks[0].valueColumn, 'value');
});

test('rejects invalid data displays and duplicate ids', () => {
  assert.throws(() => normalizeCompositionDefinition({
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    pages: [{ id: 'page', title: 'One', blocks: [{ id: 'page', type: 'data', title: 'x', aqlFunctionId: 'aql', display: 'pie' }] }],
  }), /duplicated|invalid display/i);
});

test('accepts the matrix display - one row per labelColumn value, one column per timeColumn bucket', () => {
  const composition = normalizeCompositionDefinition({
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    pages: [{ id: 'overview', title: 'Übersicht', blocks: [{
      id: 'lab-matrix', type: 'data', title: 'Laborverlauf',
      aqlFunctionId: 'lab-query', display: 'matrix',
      valueColumn: 'value', labelColumn: 'analyte', timeColumn: 'recorded_at',
    }] }],
  });
  assert.equal(composition.pages[0].blocks[0].display, 'matrix');
  assert.equal(composition.pages[0].blocks[0].labelColumn, 'analyte');
});

test('accepts the timeline display - chronological entries with a heading (labelColumn) and a value', () => {
  const composition = normalizeCompositionDefinition({
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    pages: [{ id: 'overview', title: 'Übersicht', blocks: [{
      id: 'patient-timeline', type: 'data', title: 'Patiententimeline',
      aqlFunctionId: 'events-query', display: 'timeline',
      valueColumn: 'value', labelColumn: 'event', timeColumn: 'recorded_at',
    }] }],
  });
  assert.equal(composition.pages[0].blocks[0].display, 'timeline');
  assert.equal(composition.pages[0].blocks[0].timeColumn, 'recorded_at');
});

test('moves composition blocks transactionally without duplicates or mutation', () => {
  const definition = {
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    pages: [
      { id: 'one', title: 'One', blocks: [
        { id: 'a', type: 'text', content: 'A' },
        { id: 'b', type: 'text', content: 'B' },
        { id: 'c', type: 'text', content: 'C' },
      ] },
      { id: 'two', title: 'Two', blocks: [] },
    ],
  };
  const moved = moveCompositionBlock(definition, { sourcePageId: 'one', blockId: 'a', targetPageId: 'one', targetIndex: 3 });
  assert.deepEqual(moved.pages[0].blocks.map((block) => block.id), ['b', 'c', 'a']);
  assert.deepEqual(definition.pages[0].blocks.map((block) => block.id), ['a', 'b', 'c']);

  const transferred = moveCompositionBlock(moved, { sourcePageId: 'one', blockId: 'c', targetPageId: 'two', targetIndex: 0 });
  assert.deepEqual(transferred.pages[0].blocks.map((block) => block.id), ['b', 'a']);
  assert.deepEqual(transferred.pages[1].blocks.map((block) => block.id), ['c']);
});

test('inserts a composition block at a clamped target index', () => {
  const definition = { schemaVersion: COMPOSITION_SCHEMA_VERSION, pages: [{ id: 'one', title: 'One', blocks: [] }] };
  const result = insertCompositionBlock(definition, 'one', { id: 'notice', type: 'text', content: 'Hi' }, 99);
  assert.deepEqual(result.pages[0].blocks.map((block) => block.id), ['notice']);
  assert.deepEqual(result.pages[0].layout.map((entry) => entry.blockId), ['notice']);
});

test('a negative target index clamps to the front for both blocks AND layout, never desyncing them', () => {
  // QA review finding: the layout-array insertion index used to be
  // Math.min(targetIndex, layout.length) with no lower clamp (unlike
  // blocks', via insertionIndex()) - a negative targetIndex left it
  // negative, and Array#splice treats a negative index as "from the end",
  // landing the layout entry near the end of layout[] while the block
  // itself correctly landed at blocks[0]. Both arrays describe the same
  // page's block order and must stay in the same order as each other.
  const definition = {
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    pages: [{ id: 'one', title: 'One', blocks: [
      { id: 'a', type: 'text', content: 'A' },
      { id: 'b', type: 'text', content: 'B' },
    ] }],
  };
  const result = insertCompositionBlock(definition, 'one', { id: 'notice', type: 'text', content: 'Hi' }, -1);
  assert.deepEqual(result.pages[0].blocks.map((block) => block.id), ['notice', 'a', 'b']);
  assert.deepEqual(result.pages[0].layout.map((entry) => entry.blockId), ['notice', 'a', 'b']);
});

test('migrates legacy flat blocks into persisted layout slots', () => {
  const composition = normalizeCompositionDefinition({
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    pages: [{ id: 'legacy', title: 'Legacy', blocks: [{ id: 'note', type: 'text', content: 'Kept' }] }],
  });
  assert.deepEqual(composition.pages[0].layout, [{ id: 'layout/legacy/note', element: 'block', blockId: 'note' }]);
});

test('keeps nested Form-Builder primitives and requires every clinical block exactly once', () => {
  const composition = normalizeCompositionDefinition({
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    pages: [{
      id: 'layout-page', title: 'Layout', blocks: [{ id: 'person', type: 'form', formId: 'person-form' }],
      layout: [
        { id: 'columns', element: 'TwoColumnRow' },
        { id: 'caption', element: 'Header', label: 'Aufnahme', parentId: 'columns', column: 1 },
        { id: 'person-slot', element: 'block', blockId: 'person', parentId: 'columns', column: 2 },
      ],
    }],
  });
  assert.equal(composition.pages[0].layout[1].parentId, 'columns');
  assert.throws(() => normalizeCompositionDefinition({
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    pages: [{ id: 'missing', title: 'Missing', blocks: [{ id: 'person', type: 'form', formId: 'person-form' }], layout: [] }],
  }), /missing from page/i);
});

test('derives the central Composition status from child form sessions', () => {
  assert.deepEqual(summarizeCompositionSession([]), {
    progress: { total: 0, started: 0, ready: 0, submitted: 0 }, status: 'draft',
  });
  assert.equal(summarizeCompositionSession([{ status: 'draft' }, { status: 'ready' }]).status, 'in_progress');
  assert.equal(summarizeCompositionSession([{ status: 'ready' }, { status: 'submitted' }]).status, 'ready');
  assert.equal(summarizeCompositionSession([{ status: 'submitted' }, { status: 'submitted' }]).status, 'submitted');
  assert.equal(summarizeCompositionSession([{ status: 'failed' }, { status: 'ready' }]).status, 'failed');
});

test('composition scripts expose pages and blocks, plus a trusted forms.field(...).setValue(...) escape hatch and data.onPick', () => {
  const definition = normalizeCompositionDefinition({
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    pages: [{ id: 'overview', title: 'Overview', blocks: [
      { id: 'person-form', type: 'form', formId: 'person' },
      { id: 'labs', type: 'data', title: 'Labs', aqlFunctionId: 'labs', display: 'trend' },
    ] }],
  });
  const generated = generateCompositionScriptTypes(definition);
  assert.match(generated, /"overview"/);
  assert.match(generated, /"person-form"/);
  assert.match(generated, /"labs"/);
  // Composition-Script darf direkt Felder eines eingebetteten Formulars
  // setzen (explizite Design-Entscheidung) - über eine schmale, benannte
  // API, nicht über generischen Zugriff auf das Formular selbst.
  assert.match(generated, /forms: CompositionFormsApi/);
  assert.match(generated, /field\(blockId: BlockId, fieldName: string\): FormFieldHandle/);
  assert.match(generated, /setValue\(value: unknown\): void/);
  assert.match(generated, /onPick\(id: DataBlockId, handler: \(row: Record<string, unknown>\) => void\): void/);
  assert.equal(createEmptyCompositionScript(definition).source.includes('defineCompositionScript'), true);
});

test('manualAdd form blocks accept manualAdd/requireAtLeastOne and default both to off', () => {
  const withoutFlags = normalizeCompositionDefinition({
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    pages: [{ id: 'overview', title: 'Übersicht', blocks: [{ id: 'person', type: 'form', formId: 'person-form' }] }],
  });
  assert.equal(withoutFlags.pages[0].blocks[0].manualAdd, undefined);
  assert.equal(withoutFlags.pages[0].blocks[0].requireAtLeastOne, undefined);

  const optional = normalizeCompositionDefinition({
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    pages: [{ id: 'overview', title: 'Übersicht', blocks: [{ id: 'diagnosis', type: 'form', formId: 'diagnosis-form', manualAdd: true }] }],
  });
  assert.equal(optional.pages[0].blocks[0].manualAdd, true);
  assert.equal(optional.pages[0].blocks[0].requireAtLeastOne, undefined);

  const required = normalizeCompositionDefinition({
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    pages: [{ id: 'overview', title: 'Übersicht', blocks: [{ id: 'diagnosis', type: 'form', formId: 'diagnosis-form', manualAdd: true, requireAtLeastOne: true }] }],
  });
  assert.equal(required.pages[0].blocks[0].requireAtLeastOne, true);
});

test('requireAtLeastOne without manualAdd is rejected - it is only meaningful on a manually-added block', () => {
  assert.throws(() => normalizeCompositionDefinition({
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    pages: [{ id: 'overview', title: 'Übersicht', blocks: [{ id: 'diagnosis', type: 'form', formId: 'diagnosis-form', requireAtLeastOne: true }] }],
  }), /requireAtLeastOne requires manualAdd/);
});

test('manualAdd and requireAtLeastOne reject non-boolean values', () => {
  assert.throws(() => normalizeCompositionDefinition({
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    pages: [{ id: 'overview', title: 'Übersicht', blocks: [{ id: 'diagnosis', type: 'form', formId: 'diagnosis-form', manualAdd: 'yes' }] }],
  }), /manualAdd must be a boolean/);
  assert.throws(() => normalizeCompositionDefinition({
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    pages: [{ id: 'overview', title: 'Übersicht', blocks: [{ id: 'diagnosis', type: 'form', formId: 'diagnosis-form', manualAdd: true, requireAtLeastOne: 'yes' }] }],
  }), /requireAtLeastOne must be a boolean/);
});
