import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkbenchContext } from '../../context';
import { toResult } from '../toResult';

const fieldSchema = z.object({
  path: z.string(),
  label: z.string(),
  type: z.enum(['text', 'number', 'boolean', 'date', 'datetime', 'select', 'reference', 'code']),
  required: z.boolean(),
  editable: z.boolean(),
  sourcePolicy: z.enum(['scenario', 'derived', 'generated', 'user']),
  referenceResourceTypes: z.array(z.string()).optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
});

const scenarioRunId = z.string().describe('The scenario run these forms belong to (spec section 3\'s scenarioRunId) - forms are scoped per run, same as entities/capabilities.');

/**
 * Spec sections 8/9/12/30 - FHIR Resource Forms. `ensure_fhir_resource_form`
 * covers the "create a form the first time a resource type is needed" flow
 * (generates v1 straight from that type's Resource Blueprint - never from
 * scratch); `create_fhir_resource_form`/`update_fhir_resource_form` below
 * are its explicit MCP-tool names per the spec's own tool list, but both
 * delegate to the exact same ResourceFormStore the UI's ResourceFormManager
 * uses (spec section 10 - one implementation, two entry points).
 */
export function registerResourceFormTools(server: McpServer, context: WorkbenchContext): void {
  server.registerTool('list_fhir_resource_forms', {
    title: 'List FHIR Resource Forms for a scenario run',
    description: 'Lists every FhirResourceForm registered so far for one scenario run - each one the concrete, editable field set create_fhir_resource/update_fhir_resource validate against for that resource type.',
    inputSchema: { scenarioRunId },
  }, ({ scenarioRunId }) => toResult(async () => context.forRun(scenarioRunId).forms.list()));

  server.registerTool('get_fhir_resource_form', {
    title: 'Get one FHIR Resource Form',
    description: 'Fetches one FhirResourceForm by its id (the lowercased resourceType, e.g. "patient") for a scenario run.',
    inputSchema: { scenarioRunId, id: z.string() },
  }, ({ scenarioRunId, id }) => toResult(async () => {
    const form = context.forRun(scenarioRunId).forms.get(id);
    if (!form) throw new Error(`No FhirResourceForm "${id}" in scenario run "${scenarioRunId}".`);
    return form;
  }));

  server.registerTool('create_fhir_resource_form', {
    title: 'Ensure a FHIR Resource Form exists for a resource type',
    description: 'Spec section 8: before ANY resource of a given type may be created, a Resource Form for it must exist. This ensures one - if it already exists, returns it unchanged (idempotent); otherwise generates a fresh v1 straight from that resource type\'s own Resource Blueprint and registers it. There is no unsupported-type escape hatch here - if no blueprint exists for the resourceType, this fails rather than inventing a made-up form.',
    inputSchema: { scenarioRunId, resourceType: z.string() },
  }, ({ scenarioRunId, resourceType }) => toResult(async () => context.forRun(scenarioRunId).forms.ensureForm(resourceType)));

  server.registerTool('update_fhir_resource_form', {
    title: 'Grow a FHIR Resource Form with one new or changed field',
    description: 'Spec section 12: adds a brand-new field to an existing FhirResourceForm (fails if the path is already used - edit it via the `patch` argument instead), or patches an existing field\'s config (label/type/required/editable/sourcePolicy/options). Either way bumps the form\'s version. Both the UI and this tool call the exact same ResourceFormStore method, so a field added here is immediately visible in the UI\'s ResourceFormManager and vice versa.',
    inputSchema: {
      scenarioRunId,
      formId: z.string().describe('The form\'s id, e.g. "appointment".'),
      newField: fieldSchema.optional().describe('Provide this to append a brand-new field.'),
      patch: z.object({ path: z.string(), changes: fieldSchema.partial() }).optional().describe('Provide this to change an existing field at `path`.'),
    },
  }, ({ scenarioRunId, formId, newField, patch }) => toResult(async () => {
    const forms = context.forRun(scenarioRunId).forms;
    if (newField) return forms.addField(formId, newField);
    if (patch) return forms.updateField(formId, patch.path, patch.changes);
    throw new Error('Provide either "newField" or "patch".');
  }));
}
