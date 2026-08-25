import assert from 'node:assert/strict';
import test from 'node:test';
import { ok, toolError, toResult } from '../dist/toolResult.js';
import { FormbuilderApiError } from '../dist/apiClient.js';

test('ok() wraps data as pretty-printed JSON text content', () => {
  const result = ok({ id: '1', name: 'Test' });
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(result.content[0].text), { id: '1', name: 'Test' });
  assert.equal(result.isError, undefined);
});

test('toolError() turns a FormbuilderApiError into a readable, non-throwing tool error result', () => {
  const result = toolError(new FormbuilderApiError(404, 'Form not found', { error: 'Form not found' }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /HTTP 404/);
  assert.match(result.content[0].text, /Form not found/);
});

test('toolError() handles a plain Error and an arbitrary thrown value without crashing', () => {
  assert.equal(toolError(new Error('boom')).content[0].text, 'Unexpected error: boom');
  assert.equal(toolError('not an Error object').content[0].text, 'Unexpected error: not an Error object');
});

test('toResult() resolves to ok() on success and to toolError() on rejection, never throwing itself', async () => {
  const success = await toResult(async () => ({ done: true }));
  assert.deepEqual(JSON.parse(success.content[0].text), { done: true });

  const failure = await toResult(async () => { throw new FormbuilderApiError(500, 'Internal error'); });
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /HTTP 500/);
});
