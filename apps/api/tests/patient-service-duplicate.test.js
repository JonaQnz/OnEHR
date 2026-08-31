const assert = require('node:assert/strict');
const test = require('node:test');
const prisma = require('../dist/db/prisma').default;
const configService = require('../dist/services/configService');
const { createPatient } = require('../dist/services/patientService');
const { HttpError } = require('../dist/middleware/errorHandler');

// QA review finding: creating a patient whose id/namespace already exists
// threw a plain Error, which errorHandler.ts maps to HTTP 500 for anything
// that isn't an HttpError - a routine "patient already exists" conflict
// (e.g. a clinician double-clicking "create patient") looked like a
// server crash to the frontend instead of a handled 409.
test('creating a patient that already exists in the namespace rejects with HttpError 409, not a generic 500', async () => {
  const originalFindUnique = prisma.patient.findUnique;
  const originalGetActiveEhrbaseConnection = configService.getActiveEhrbaseConnection;
  prisma.patient.findUnique = async () => ({ id: 'existing-1', patientId: 'p-1', patientNamespace: 'default' });
  configService.getActiveEhrbaseConnection = () => ({ id: 'test-connection', subjectNamespace: 'default' });
  try {
    await assert.rejects(
      () => createPatient({ patientId: 'p-1', firstName: 'Ada', lastName: 'Lovelace' }),
      (error) => {
        assert.ok(error instanceof HttpError, `expected an HttpError, got ${error?.constructor?.name}: ${error?.message}`);
        assert.equal(error.status, 409);
        assert.match(error.message, /already exists/);
        return true;
      },
    );
  } finally {
    prisma.patient.findUnique = originalFindUnique;
    configService.getActiveEhrbaseConnection = originalGetActiveEhrbaseConnection;
  }
});
