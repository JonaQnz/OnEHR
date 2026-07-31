const assert = require('node:assert/strict');
const test = require('node:test');
const { PLUGIN_API_VERSION, defineFunctionPackage } = require('../dist');

test('exposes a stable public SDK contract', () => {
  assert.equal(PLUGIN_API_VERSION, '1.0');
  const pkg = defineFunctionPackage({ id: 'test.functions', version: '1.0.0', functions: [] });
  assert.deepEqual(pkg, { id: 'test.functions', version: '1.0.0', functions: [] });
});
