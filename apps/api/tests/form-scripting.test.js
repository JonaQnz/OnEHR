const assert = require('node:assert/strict');
const test = require('node:test');
const { compileFormScript } = require('../dist/scripting/formScriptCompiler');

function definition() {
  return {
    id: 'script-form',
    name: 'Script form',
    version: '1.0.0',
    schemaVersion: '1.0',
    revision: 0,
    extensions: {},
    sourceTemplates: [],
    bindings: {},
    locales: { en: {} },
    layout: {
      type: 'form',
      children: [
        { type: 'input-number', id: 'weight', name: 'weight', label: 'Weight' },
        { type: 'input-number', id: 'height', name: 'height', label: 'Height' },
        { type: 'input-number', id: 'bmi', name: 'bmi', label: 'BMI' },
        {
          type: 'input-select',
          id: 'status',
          name: 'status',
          label: 'Status',
          options: [{ value: 'current', text: 'Current' }],
        },
        { type: 'container', id: 'details', children: [] },
        {
          type: 'container',
          id: 'medications',
          label: 'Medications',
          repeatable: true,
          children: [
            { type: 'input-text', id: 'substance', name: 'substance', label: 'Substance' },
          ],
        },
        { type: 'button', id: 'load', label: 'Load' },
      ],
    },
  };
}

function definitionWithConnector() {
  const form = definition();
  form.extensions['formbuilder.scripting'] = {
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
        properties: {
          id: { type: 'string' },
          firstName: { type: 'string' },
        },
        required: ['id', 'firstName'],
        additionalProperties: true,
      },
    }],
  };
  return form;
}

test('compiles a typed form script and emits browser-ready JavaScript', () => {
  const result = compileFormScript(definition(), `
    import { defineFormScript } from "@formbuilder/runtime";
    export default defineFormScript(({ form, ui }) => {
      form.field("weight").onChange(({ value }) => {
        ui.group("details").setVisible(value != null);
      });
      ui.button("load").onClick(() => form.field("weight").setValue(82));
    });
  `);

  assert.equal(result.valid, true);
  assert.equal(result.document.diagnostics.length, 0);
  assert.match(result.document.compiled, /export default/);
  assert.doesNotMatch(result.document.compiled, /@formbuilder\/runtime/);
});

test('reports unknown schema ids before publishing', () => {
  const result = compileFormScript(definition(), `
    import { defineFormScript } from "@formbuilder/runtime";
    export default defineFormScript(({ form }) => {
      form.field("weigth").setValue(82);
    });
  `);

  assert.equal(result.valid, false);
  assert.ok(result.document.diagnostics.some((item) => /weigth/.test(item.message)));
});

test('rejects browser globals, direct fetch and arbitrary imports', () => {
  const result = compileFormScript(definition(), `
    import thing from "arbitrary-package";
    import { defineFormScript } from "@formbuilder/runtime";
    export default defineFormScript(() => {
      window.alert(String(thing));
      fetch("/secret");
    });
  `);

  assert.equal(result.valid, false);
  assert.ok(result.document.diagnostics.some((item) => item.code === 'SCRIPT_IMPORT_NOT_ALLOWED'));
  assert.ok(result.document.diagnostics.some((item) => item.code === 'SCRIPT_FORBIDDEN_GLOBAL'));
});

test('types computed fields, validators, dynamic options and repeatable groups', () => {
  const result = compileFormScript(definition(), `
    import { defineFormScript } from "@formbuilder/runtime";
    export default defineFormScript(({ form, ui, logger }) => {
      form.computed("bmi", {
        dependsOn: ["weight", "height"] as const,
        persist: false,
        calculate: ({ weight, height }) => (
          weight == null || height == null || height === 0
            ? null
            : weight / (height * height)
        ),
      });
      form.field("weight").validate((value) => (
        value != null && value < 0 ? "Weight must not be negative." : null
      ));
      ui.field("status").setOptions([
        { value: "current", label: "Current" },
        { value: "former", label: "Former" },
      ]);
      form.group("medications").onItemChange(({ fieldId, index }) => {
        logger.debug(String(fieldId) + ":" + index);
      });
    });
  `);

  assert.equal(result.valid, true, JSON.stringify(result.document.diagnostics));
  assert.match(result.document.generatedTypes, /RepeatableGroupId = "medications"/);
  assert.match(result.document.generatedTypes, /computed<K extends FieldId/);
  assert.match(result.document.generatedTypes, /setOptions/);
  assert.match(result.document.generatedTypes, /"substance": string \| null/);
});

test('types enabled connector operations and abortable debounced changes', () => {
  const result = compileFormScript(definitionWithConnector(), `
    import { defineFormScript } from "@formbuilder/runtime";
    export default defineFormScript(({ form, api, logger }) => {
      form.field("status").onChange(async ({ signal }) => {
        const patient = await api.call("patient.get", { id: "patient-1" }, { signal });
        logger.info(patient.firstName);
        const samePatient = await api.request({
          connector: "patient",
          operation: "get",
          input: { id: patient.id },
        });
        logger.info(samePatient.firstName);
      }, { debounce: 300, cancelPrevious: true });
    });
  `);

  assert.equal(result.valid, true, JSON.stringify(result.document.diagnostics));
  assert.match(result.document.generatedTypes, /ConnectorOperation = "patient.get"/);
  assert.match(result.document.generatedTypes, /cancelPrevious/);
});

test('reports connector operations that are not enabled for the form', () => {
  const result = compileFormScript(definitionWithConnector(), `
    import { defineFormScript } from "@formbuilder/runtime";
    export default defineFormScript(async ({ api }) => {
      await api.call("patient.delete", { id: "patient-1" });
    });
  `);

  assert.equal(result.valid, false);
  assert.ok(result.document.diagnostics.some((item) => /patient\.delete/.test(item.message)));
});
