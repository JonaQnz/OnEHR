'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Only the barrel is public: it must re-export exactly what dist/index.js
 * does, and dist subpaths must be rejected by "exports" rather than
 * reachable as part of the package's API surface.
 */

test('the package entry exposes the same keys as dist/index.js', () => {
  const entryKeys = Object.keys(require('openehr-engine'));

  assert.notEqual(entryKeys.length, 0);
  assert.deepEqual(entryKeys, Object.keys(require('../dist/index.js')));
});

test('an undeclared dist subpath is not exported', () => {
  assert.throws(
    () => require('openehr-engine/dist/diff'),
    (error) => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  );
});
