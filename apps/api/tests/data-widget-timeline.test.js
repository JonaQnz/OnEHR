const assert = require('node:assert/strict');
const test = require('node:test');

// Same gap as data-widget-matrix.test.js: dataWidgetService.ts keeps its own
// displays enum, separate from CompositionDataBlock['display'] in
// core/composition, so 'timeline' had to be added in both places.
const prisma = require('../dist/db/prisma').default;
const widgets = require('../dist/services/dataWidgetService');

const original = {
  aqlFunctionFindFirst: prisma.aqlFunction.findFirst,
  dataWidgetCreate: prisma.dataWidget.create,
};

function installStore({ query } = {}) {
  prisma.aqlFunction.findFirst = async () => ({
    id: 'aql-events', enabled: true,
    query: query ?? "SELECT e/ehr_status/subject/external_ref/id/value AS patient, c/archetype_details/template_id/value AS event, c/context/start_time/value AS recorded_at FROM EHR e CONTAINS COMPOSITION c",
  });
  prisma.dataWidget.create = async ({ data }) => ({ id: 'widget-1', ...data, createdAt: new Date('2026-08-31T00:00:00.000Z'), updatedAt: new Date('2026-08-31T00:00:00.000Z') });
  return {
    restore: () => {
      prisma.aqlFunction.findFirst = original.aqlFunctionFindFirst;
      prisma.dataWidget.create = original.dataWidgetCreate;
    },
  };
}

test('a timeline widget with labelColumn and timeColumn present as AQL aliases saves successfully', async () => {
  const store = installStore();
  try {
    const widget = await widgets.createDataWidget({
      name: 'Patiententimeline', aqlFunctionId: 'aql-events',
      configuration: { display: 'timeline', labelColumn: 'event', timeColumn: 'recorded_at' },
    });
    assert.equal(widget.configuration.display, 'timeline');
  } finally { store.restore(); }
});

test('a timeline widget missing labelColumn is rejected with a clear message', async () => {
  const store = installStore();
  try {
    await assert.rejects(
      widgets.createDataWidget({
        name: 'Patiententimeline', aqlFunctionId: 'aql-events',
        configuration: { display: 'timeline', timeColumn: 'recorded_at' },
      }),
      /timeline widgets require both labelColumn and timeColumn/i,
    );
  } finally { store.restore(); }
});

test('a timeline widget missing timeColumn is rejected with a clear message', async () => {
  const store = installStore();
  try {
    await assert.rejects(
      widgets.createDataWidget({
        name: 'Patiententimeline', aqlFunctionId: 'aql-events',
        configuration: { display: 'timeline', labelColumn: 'event' },
      }),
      /timeline widgets require both labelColumn and timeColumn/i,
    );
  } finally { store.restore(); }
});
