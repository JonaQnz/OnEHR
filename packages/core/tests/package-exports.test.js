'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * The package declares its public entry points explicitly via "exports".
 * `core` (the barrel) and `core/aql-runtime` (the dependency-free submodule
 * the Form Script worker deep-imports) must expose the same function
 * instance, and no other dist subpath may be reachable by deep import.
 */

test('the barrel and the aql-runtime entry expose the same resolveAqlResultPath', () => {
  const barrel = require('core');
  const aqlRuntime = require('core/aql-runtime');

  assert.equal(typeof barrel.resolveAqlResultPath, 'function');
  assert.equal(aqlRuntime.resolveAqlResultPath, barrel.resolveAqlResultPath);
});

test('an undeclared dist subpath is not exported', () => {
  assert.throws(
    () => require('core/dist/auth'),
    (error) => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  );
});
