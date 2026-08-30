const assert = require('node:assert/strict');
const test = require('node:test');

// buildSessionRuntimeContext unconditionally fetched a Form Section's
// patient's latest submitted Composition from EHRbase on every single
// session creation - regardless of the launch's own load policy ('never'
// included) - to populate a form script's read-only context.composition.
// Paid on every block of every Composition page, even when nothing ever
// reads context.composition. settings.runtime.loadLatestCompositionContext:
// false now skips that EHRbase round-trip entirely for a Form Section that
// doesn't need it; unset/true is unchanged behavior.
const ehrbaseDataProvider = require('../dist/services/ehrbaseDataProvider');
const aql = require('../dist/services/aqlFunctionService');

const original = { loadLatestCompositionContext: ehrbaseDataProvider.EhrbaseDataProvider.prototype.loadLatestCompositionContext };

function installStore() {
  let callCount = 0;
  ehrbaseDataProvider.EhrbaseDataProvider.prototype.loadLatestCompositionContext = async function loadLatestCompositionContext() {
    callCount += 1;
    return { ehrId: 'ehr-1', templateId: 'vg_Diagnosis.v1.1.1', flat: {}, loadedAt: new Date().toISOString() };
  };
  return {
    calls: () => callCount,
    restore: () => { ehrbaseDataProvider.EhrbaseDataProvider.prototype.loadLatestCompositionContext = original.loadLatestCompositionContext; },
  };
}

function form(runtimeSettings) {
  return {
    id: 'diagnosis-form', version: '1.2.0',
    definition: {
      id: 'diagnosis-form', name: 'Diagnose & Problem', version: '1.2.0',
      sourceTemplates: [{ id: 'vg_Diagnosis.v1.1.1', alias: 'vg_diagnosis.v1.1.1', version: '1.1.1', type: 'openEhrWebTemplate' }],
      layout: { type: 'form', children: [] }, bindings: {}, locales: {},
      ...(runtimeSettings ? { settings: { runtime: runtimeSettings } } : {}),
    },
  };
}
const context = { mode: 'create', patientId: 'patient-1' };

test('default (unset loadLatestCompositionContext) fetches the latest composition context', async () => {
  const store = installStore();
  try {
    const result = await aql.buildSessionRuntimeContext(form(), context);
    assert.equal(store.calls(), 1);
    assert.ok(result.composition);
  } finally { store.restore(); }
});

test('loadLatestCompositionContext: true is unchanged - still fetches', async () => {
  const store = installStore();
  try {
    const result = await aql.buildSessionRuntimeContext(form({ loadLatestCompositionContext: true }), context);
    assert.equal(store.calls(), 1);
    assert.ok(result.composition);
  } finally { store.restore(); }
});

test('loadLatestCompositionContext: false skips the EHRbase round-trip entirely', async () => {
  const store = installStore();
  try {
    const result = await aql.buildSessionRuntimeContext(form({ loadLatestCompositionContext: false }), context);
    assert.equal(store.calls(), 0);
    assert.equal(result.composition, undefined);
  } finally { store.restore(); }
});
