import assert from 'node:assert/strict';
import test from 'node:test';
import { ok, toolError, toResult } from '../dist/toolResult.js';
import { EhrbaseError } from '../dist/ehrbaseClient.js';

test('ok() wraps a plain object as pretty-printed JSON text content', () => {
  const result = ok({ template_id: 'vg_Procedure.v1.1.0' });
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(result.content[0].text), { template_id: 'vg_Procedure.v1.1.0' });
  assert.equal(result.isError, undefined);
});

test('ok() passes a string straight through instead of double-encoding it as JSON', () => {
  const result = ok('<template>raw opt xml</template>');
  assert.equal(result.content[0].text, '<template>raw opt xml</template>');
});

test('toolError() turns an EhrbaseError into a readable, non-throwing tool error result', () => {
  const result = toolError(new EhrbaseError(400, 'EHRbase rejected the template', { error: 'Invalid ADL' }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /HTTP 400/);
  assert.match(result.content[0].text, /Invalid ADL/);
});

test('toolError() handles a plain Error and an arbitrary thrown value without crashing', () => {
  assert.equal(toolError(new Error('boom')).content[0].text, 'Unexpected error: boom');
  assert.equal(toolError('not an Error object').content[0].text, 'Unexpected error: not an Error object');
});

test('toResult() resolves to ok() on success and to toolError() on rejection, never throwing itself', async () => {
  const success = await toResult(async () => ({ status: 'created' }));
  assert.deepEqual(JSON.parse(success.content[0].text), { status: 'created' });

  const failure = await toResult(async () => { throw new EhrbaseError(409, 'already exists'); });
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /HTTP 409/);
});
