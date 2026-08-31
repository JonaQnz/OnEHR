const assert = require('node:assert/strict');
const test = require('node:test');
const { errorHandler, HttpError } = require('../dist/middleware/errorHandler');

function fakeResponse() {
  const res = { statusCode: undefined, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

// QA review finding: every non-HttpError (Prisma constraint violations,
// axios/EHRbase network failures, genuine bugs) was echoed back to the
// client verbatim as { error: error.message } at HTTP 500 - potentially
// leaking internal details (DB constraint/column names, internal URLs,
// stack-adjacent text) to any authenticated caller who happens to trigger
// one.
test('an HttpError is client-facing: its own message and status are returned as-is', () => {
  const res = fakeResponse();
  errorHandler(new HttpError(409, 'Patient with ID p-1 already exists in namespace default'), {}, res, () => {});
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'Patient with ID p-1 already exists in namespace default');
});

test('an unexpected Error is redacted to a generic message at 500, never echoing internals', () => {
  const res = fakeResponse();
  errorHandler(new Error('duplicate key value violates unique constraint "patient_namespace_id_key" on table "Patient"'), {}, res, () => {});
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Unexpected server error');
});

test('a thrown non-Error value is also redacted to the generic message at 500', () => {
  const res = fakeResponse();
  errorHandler('a raw string throw', {}, res, () => {});
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Unexpected server error');
});

test('an HttpError\'s details (validation messages) are still passed through to the client', () => {
  const res = fakeResponse();
  const details = { code: 'FORM_SCRIPT_INVALID', messages: [{ severity: 'error', path: 'weight', message: 'must be a number' }] };
  errorHandler(new HttpError(422, 'Validation failed', details), {}, res, () => {});
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.error, 'Validation failed');
  assert.deepEqual(res.body.messages, details.messages);
  assert.equal(res.body.code, 'FORM_SCRIPT_INVALID');
});
