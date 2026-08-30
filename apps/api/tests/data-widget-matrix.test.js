const assert = require('node:assert/strict');
const test = require('node:test');

// dataWidgetService.ts keeps its own displays enum, separate from
// CompositionDataBlock['display'] in core/composition - a data widget
// (the Widgets admin surface) and a Composition's own data block are two
// different persisted shapes, so 'matrix' had to be added in both places.
// This covers the widget-service side after that gap caused newly-created
// matrix widgets to fail to save with a 400.
const prisma = require('../dist/db/prisma').default;
const widgets = require('../dist/services/dataWidgetService');

const original = {
  aqlFunctionFindFirst: prisma.aqlFunction.findFirst,
  dataWidgetCreate: prisma.dataWidget.create,
};

function installStore({ query } = {}) {
  prisma.aqlFunction.findFirst = async () => ({
    id: 'aql-labs', enabled: true,
    query: query ?? 'SELECT o/data[at0001]/items[at0024]/value/value AS analyte, o/data[at0001]/items[at0001]/value/magnitude AS value, o/data[at0001]/time/value AS recorded_at FROM EHR e CONTAINS OBSERVATION o',
  });
  prisma.dataWidget.create = async ({ data }) => ({ id: 'widget-1', ...data, createdAt: new Date('2026-08-31T00:00:00.000Z'), updatedAt: new Date('2026-08-31T00:00:00.000Z') });
  return {
    restore: () => {
      prisma.aqlFunction.findFirst = original.aqlFunctionFindFirst;
      prisma.dataWidget.create = original.dataWidgetCreate;
    },
  };
}

test('a matrix widget with labelColumn, valueColumn, and timeColumn all present as AQL aliases saves successfully', async () => {
  const store = installStore();
  try {
    const widget = await widgets.createDataWidget({
      name: 'Laborverlauf – Matrix', aqlFunctionId: 'aql-labs',
      configuration: { display: 'matrix', valueColumn: 'value', labelColumn: 'analyte', timeColumn: 'recorded_at' },
    });
    assert.equal(widget.configuration.display, 'matrix');
  } finally { store.restore(); }
});

test('a matrix widget missing labelColumn is rejected with a clear message', async () => {
  const store = installStore();
  try {
    await assert.rejects(
      widgets.createDataWidget({
        name: 'Laborverlauf – Matrix', aqlFunctionId: 'aql-labs',
        configuration: { display: 'matrix', valueColumn: 'value', timeColumn: 'recorded_at' },
      }),
      /matrix widgets require both labelColumn and timeColumn/i,
    );
  } finally { store.restore(); }
});

test('a matrix widget missing timeColumn is rejected with a clear message', async () => {
  const store = installStore();
  try {
    await assert.rejects(
      widgets.createDataWidget({
        name: 'Laborverlauf – Matrix', aqlFunctionId: 'aql-labs',
        configuration: { display: 'matrix', valueColumn: 'value', labelColumn: 'analyte' },
      }),
      /matrix widgets require both labelColumn and timeColumn/i,
    );
  } finally { store.restore(); }
});

test('a matrix widget referencing a column with no matching AQL alias is rejected', async () => {
  const store = installStore({ query: 'SELECT o/data[at0001]/items[at0024]/value/value AS analyte, o/data[at0001]/time/value AS recorded_at FROM EHR e CONTAINS OBSERVATION o' });
  try {
    await assert.rejects(
      widgets.createDataWidget({
        name: 'Laborverlauf – Matrix', aqlFunctionId: 'aql-labs',
        configuration: { display: 'matrix', valueColumn: 'value', labelColumn: 'analyte', timeColumn: 'recorded_at' },
      }),
      /named AQL columns.*value/i,
    );
  } finally { store.restore(); }
});
