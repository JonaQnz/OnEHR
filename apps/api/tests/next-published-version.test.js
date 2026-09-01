const assert = require('node:assert/strict');
const test = require('node:test');
const { nextPublishedVersion } = require('../dist/routes/formRoutes');

// Bug found live: every fresh form is seeded at "0.1.0-draft" (major 0,
// minor 1 - see the three '0.1.0-draft' seed sites in formRoutes.ts). The
// publish handler used to only force major 0 -> 1 and pass minor/patch
// through unchanged, so a form's very first publish produced "1.1.0"
// instead of the intended "1.0.0" - confirmed against a real form
// ("Diagnose (Basis)") that published as 1.1.0 straight from 0.1.0-draft.

test('a fresh form\'s first-ever publish lands on 1.0.0, not 1.1.0', () => {
  assert.equal(nextPublishedVersion('0.1.0-draft'), '1.0.0');
});

test('a major-0 draft with any other minor/patch still collapses to 1.0.0', () => {
  assert.equal(nextPublishedVersion('0.3.0-draft'), '1.0.0');
  assert.equal(nextPublishedVersion('0.1.4-draft'), '1.0.0');
});

test('a re-draft of an already-published form (major >= 1) publishes at its own version verbatim', () => {
  assert.equal(nextPublishedVersion('1.1.0-draft'), '1.1.0');
  assert.equal(nextPublishedVersion('2.4.0-draft'), '2.4.0');
});

test('an unparseable version string falls back to 1.0.0', () => {
  assert.equal(nextPublishedVersion('not-a-version'), '1.0.0');
});
