const assert = require('node:assert/strict');
const test = require('node:test');
const {
  FormScriptAiError,
  FormScriptAiRateLimiter,
  buildFormScriptAiMessages,
  createFormScriptLineDiff,
  generateFormScriptCandidate,
  stripCodeFence,
} = require('../dist/scripting/formScriptAiService');
const { compileFormScript } = require('../dist/scripting/formScriptCompiler');

function definition() {
  return {
    id: 'ai-form',
    name: 'AI form',
    version: '1.0.0',
    schemaVersion: '1.0',
    revision: 0,
    extensions: {
      'formbuilder.scripting': {
        allowedOperations: ['patient.get'],
        operations: [{
          id: 'patient.get',
          label: 'Patient laden',
          permissions: ['patient:read'],
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            additionalProperties: false,
          },
          outputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: true,
          },
        }],
      },
    },
    sourceTemplates: [],
    bindings: {},
    locales: { de: { "[name='status']": { label: 'Status' } } },
    layout: {
      type: 'form',
      children: [
        { type: 'input-select', id: 'status', name: 'status', label: 'Status' },
        { type: 'container', id: 'details', children: [] },
      ],
    },
    formScript: {
      language: 'typescript',
      source: '// not used by prompt definition',
      compiled: 'SECRET_COMPILED_ARTIFACT',
      generatedTypes: '',
      diagnostics: [],
    },
  };
}

const currentSource = `
import { defineFormScript } from "@formbuilder/runtime";
export default defineFormScript(() => {});
`.trim();

test('builds a schema-, type-, connector-, diagnostic-, and source-aware prompt', () => {
  const form = definition();
  const compilation = compileFormScript(form, currentSource);
  const messages = buildFormScriptAiMessages(form, currentSource, 'Show details for current status.', compilation);
  const prompt = messages.map((message) => message.content).join('\n');

  assert.match(prompt, /Show details for current status/);
  assert.match(prompt, /"status"/);
  assert.match(prompt, /patient\.get/);
  assert.match(prompt, /declare module "@formbuilder\/runtime"/);
  assert.match(prompt, /CURRENT form-script\.ts/);
  assert.doesNotMatch(prompt, /SECRET_COMPILED_ARTIFACT/);
  assert.match(messages[0].content, /complete form-script\.ts source only/);
});

test('generates, strips fences, compiles, and diffs an AI candidate without applying it', async () => {
  const candidateSource = `
import { defineFormScript } from "@formbuilder/runtime";
export default defineFormScript(({ form, ui }) => {
  form.field("status").onChange(({ value }) => {
    ui.group("details").setVisible(value === "current");
  });
});
`.trim();
  const provider = {
    async generate() {
      return `\`\`\`ts\n${candidateSource}\n\`\`\``;
    },
  };

  const candidate = await generateFormScriptCandidate(
    definition(),
    currentSource,
    'Show details for current status.',
    provider,
  );

  assert.equal(candidate.candidateSource, candidateSource);
  assert.equal(candidate.valid, true, JSON.stringify(candidate.diagnostics));
  assert.ok(candidate.diff.some((line) => line.kind === 'remove'));
  assert.ok(candidate.diff.some((line) => line.kind === 'add'));
  assert.equal(currentSource.includes('onChange'), false);
});

test('returns compiler and security diagnostics for an invalid AI candidate', async () => {
  const provider = {
    async generate() {
      return `
        import { defineFormScript } from "@formbuilder/runtime";
        export default defineFormScript(() => fetch("/patients"));
      `;
    },
  };

  const candidate = await generateFormScriptCandidate(
    definition(),
    currentSource,
    'Load data directly.',
    provider,
  );

  assert.equal(candidate.valid, false);
  assert.ok(candidate.diagnostics.some((diagnostic) => diagnostic.code === 'SCRIPT_FORBIDDEN_GLOBAL'));
});

test('creates a stable line diff with old and new line numbers', () => {
  const diff = createFormScriptLineDiff('one\ntwo\nthree', 'one\nchanged\nthree\nfour');

  assert.deepEqual(diff, [
    { kind: 'context', text: 'one', oldLine: 1, newLine: 1 },
    { kind: 'remove', text: 'two', oldLine: 2 },
    { kind: 'add', text: 'changed', newLine: 2 },
    { kind: 'context', text: 'three', oldLine: 3, newLine: 3 },
    { kind: 'add', text: 'four', newLine: 4 },
  ]);
});

test('validates instructions, code fences, and per-user rate limits', async () => {
  assert.equal(stripCodeFence('```typescript\nconst value = 1;\n```'), 'const value = 1;');
  await assert.rejects(
    generateFormScriptCandidate(definition(), currentSource, '   ', { generate: async () => '' }),
    (error) => error instanceof FormScriptAiError && error.code === 'FORM_SCRIPT_AI_INSTRUCTION_REQUIRED',
  );

  const limiter = new FormScriptAiRateLimiter(2, 60_000);
  limiter.assertAllowed('user:form');
  limiter.assertAllowed('user:form');
  assert.throws(
    () => limiter.assertAllowed('user:form'),
    (error) => error instanceof FormScriptAiError && error.code === 'FORM_SCRIPT_AI_RATE_LIMIT',
  );
});
