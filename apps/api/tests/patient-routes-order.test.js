const assert = require('node:assert/strict');
const test = require('node:test');
const patientRoutes = require('../dist/routes/patientRoutes').default;

// Express matches routes in REGISTRATION order, and `/:id` matches any
// single path segment - so a later-registered `/creation-configuration`
// (also one segment) was being swallowed by an earlier `/:id`
// (id="creation-configuration"), returning "Patient not found" for a route
// that never looks up a patient at all. Confirmed live 2026-09-02: this is
// exactly why the Form Builder UI's "Patient anlegen" quick-create dialog
// silently fell back to a plain EHRbase-shaped form and then failed for
// real at submit time on a FHIR-mode deployment ("personFormValues is
// required"). A full HTTP-level test would need a live DB; inspecting the
// compiled Express Router's own registration order directly (no server,
// no DB) is a faster, more precise regression guard for the actual root
// cause - a route ordering mistake, not request/response behavior.
function registeredGetPaths(router) {
  return router.stack
    .filter((layer) => layer.route && layer.route.methods.get)
    .map((layer) => layer.route.path);
}

test('GET /creation-configuration is registered before GET /:id, so it is never shadowed', () => {
  const paths = registeredGetPaths(patientRoutes);
  const configIndex = paths.indexOf('/creation-configuration');
  const idIndex = paths.indexOf('/:id');
  assert.notEqual(configIndex, -1, '/creation-configuration must be registered as a GET route');
  assert.notEqual(idIndex, -1, '/:id must be registered as a GET route');
  assert.ok(configIndex < idIndex, `/creation-configuration (index ${configIndex}) must be registered before /:id (index ${idIndex})`);
});

// General safety net: any OTHER single-segment literal path added later
// (a mistake this specific fix doesn't prevent by itself) would hit the
// same shadowing bug. Assert the actual literal-vs-parametric ordering
// invariant directly, so a future route addition trips this test instead
// of silently reintroducing the class of bug.
test('every single-segment literal GET path is registered before the first single-segment parametric (:id) GET path', () => {
  const paths = registeredGetPaths(patientRoutes);
  const segments = (path) => path.split('/').filter(Boolean);
  const isSingleSegment = (path) => segments(path).length === 1;
  const isParam = (path) => segments(path)[0].startsWith(':');
  const singleSegmentPaths = paths.filter(isSingleSegment);
  const firstParamIndex = singleSegmentPaths.findIndex(isParam);
  if (firstParamIndex === -1) return; // no single-segment param route at all - nothing to shadow
  const literalsAfterParam = singleSegmentPaths.slice(firstParamIndex + 1).filter((path) => !isParam(path));
  assert.deepEqual(literalsAfterParam, [], `these literal routes are registered after the parametric one and would be permanently unreachable: ${literalsAfterParam.join(', ')}`);
});
