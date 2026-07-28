const assert = require('node:assert/strict');
const test = require('node:test');

const { getConfig, getSafeConfig } = require('../dist/services/configService');

test('configuration never falls back to a source-code EHRbase password', () => {
  const previous = process.env.EHRBASE_PASS;
  delete process.env.EHRBASE_PASS;

  try {
    assert.equal(getConfig().ehrbasePass, undefined);
    assert.equal(getSafeConfig().ehrbasePass, '');
  } finally {
    if (previous === undefined) delete process.env.EHRBASE_PASS;
    else process.env.EHRBASE_PASS = previous;
  }
});

test('safe configuration masks an explicitly configured password', () => {
  const previous = process.env.EHRBASE_PASS;
  process.env.EHRBASE_PASS = 'test-secret';

  try {
    assert.equal(getConfig().ehrbasePass, 'test-secret');
    assert.equal(getSafeConfig().ehrbasePass, '***');
  } finally {
    if (previous === undefined) delete process.env.EHRBASE_PASS;
    else process.env.EHRBASE_PASS = previous;
  }
});
