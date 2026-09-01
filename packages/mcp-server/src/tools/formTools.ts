import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FormbuilderApiClient } from '../apiClient.js';
import { toResult } from '../toolResult.js';

/** Design-time tools: browsing/importing openEHR WebTemplates, and the full
 * form/Composition lifecycle (a Composition is just a Form whose layout
 * composes other forms - there is no separate Composition entity or API). */
export function registerFormTools(server: McpServer, api: FormbuilderApiClient): void {
  server.registerTool('list_forms', {
    title: 'List forms',
    description: 'Lists forms and Compositions (a Composition is a form with kind "composition") - `kind` and `parent_id` (a stable id shared by all of one form\'s versions/drafts) are top-level fields on each row. With no arguments, returns every version/status\'s FULL definition (layout, bindings, compiled formScript, sourcemaps) - can be very large once a project has real history. For routine "what forms/versions exist" browsing, pass `status` (e.g. "published") and/or `summary: true` (id/parent_id/name/version/status/kind/timestamps only, no canonical_json) - then use get_form for one specific id\'s full definition.',
    inputSchema: {
      status: z.string().optional().describe('Comma-separated status filter, e.g. "published" or "draft,published". Omit for all statuses.'),
      summary: z.boolean().optional().describe('true = lightweight rows (id, parent_id, name, version, status, kind, createdAt, updatedAt) instead of the full canonical_json per row.'),
    },
  }, ({ status, summary }) => toResult(() => {
    const query = new URLSearchParams();
    if (status) query.set('status', status);
    if (summary) query.set('summary', 'true');
    const queryString = query.toString();
    return api.get(`/api/forms${queryString ? `?${queryString}` : ''}`);
  }));

  server.registerTool('get_form', {
    title: 'Get a form',
    description: 'Fetches one form/Composition by its id, including its full canonical definition (layout, bindings, sourceTemplates, formScript, extensions). Read this before calling update_form so you edit the current definition rather than an assumed one.',
    inputSchema: { id: z.string().describe('The form id (a specific version/draft, not the parentId).') },
  }, ({ id }) => toResult(() => api.get(`/api/forms/${encodeURIComponent(id)}`)));

  server.registerTool('list_form_versions', {
    title: 'List a form family\'s versions',
    description: 'Lists every version/draft that shares the given parentId, and separately the latest published one - useful to find the current draft to edit, or confirm nothing published is being clobbered.',
    inputSchema: { parentId: z.string() },
  }, ({ parentId }) => toResult(async () => ({
    versions: await api.get(`/api/forms/parent/${encodeURIComponent(parentId)}/versions`),
    latestPublished: await api.get(`/api/forms/parent/${encodeURIComponent(parentId)}/latest-published`).catch(() => null),
  })));

  server.registerTool('create_form', {
    title: 'Create a new empty form or Composition',
    description: 'Creates a new draft form (or, with kind "composition", a Composition) with an empty layout. Returns the created form with its id - use update_form afterwards to actually build it out, since this only creates a blank shell.',
    inputSchema: {
      name: z.string().optional().describe('Display name. Defaults to "New Form".'),
      kind: z.enum(['form', 'composition']).optional().describe('"composition" creates a Composition (a page/block structure that composes other forms) instead of a plain form.'),
    },
  }, ({ name, kind }) => toResult(() => api.post('/api/forms', { name, kind })));

  server.registerTool('update_form', {
    title: 'Replace a form\'s definition',
    description: 'Replaces a form/Composition\'s full canonical definition (layout, bindings, sourceTemplates, locales, formScript, extensions, ...). This is a full PUT, not a patch - always get_form first and send back the complete, modified object, not a partial one. The server re-validates, re-compiles any form/Composition script, bumps the revision, and returns the saved form.',
    inputSchema: {
      id: z.string(),
      canonicalForm: z.record(z.string(), z.unknown()).describe('The complete canonical form definition object, as returned by get_form\'s canonical_json field, with your changes applied.'),
    },
  }, ({ id, canonicalForm }) => toResult(() => api.put(`/api/forms/${encodeURIComponent(id)}`, canonicalForm)));

  server.registerTool('publish_form', {
    title: 'Publish a form',
    description: 'Publishes a draft form/Composition, assigning it a release version (e.g. 1.0.0). A published form is immutable - use create_form_draft to make further changes after publishing.',
    inputSchema: { id: z.string() },
  }, ({ id }) => toResult(() => api.post(`/api/forms/${encodeURIComponent(id)}/publish`)));

  server.registerTool('create_form_draft', {
    title: 'Create a new draft from a published form',
    description: 'Creates a new editable draft version from a published form/Composition, so it can be changed without touching the live published version. Returns the new draft form.',
    inputSchema: { id: z.string().describe('The id of the published form to branch a new draft from.') },
  }, ({ id }) => toResult(() => api.post(`/api/forms/${encodeURIComponent(id)}/create-draft`)));

  server.registerTool('archive_form', {
    title: 'Archive a form',
    description: 'Archives a form/Composition version so it stops appearing as an active option, without deleting it.',
    inputSchema: { id: z.string() },
  }, ({ id }) => toResult(() => api.post(`/api/forms/${encodeURIComponent(id)}/archive`)));

  server.registerTool('delete_form', {
    title: 'Delete a form',
    description: 'Soft-deletes a form/Composition version (marks it deleted; it stops appearing as an active option). Prefer archive_form for something you might want back; use this for genuine cleanup, e.g. removing a form you just created by mistake.',
    inputSchema: { id: z.string() },
  }, ({ id }) => toResult(() => api.post(`/api/forms/${encodeURIComponent(id)}/delete`)));

  server.registerTool('check_form_script', {
    title: 'Validate a form script',
    description: 'Compiles and statically validates TypeScript form-script source against a form\'s current shape (its generated field types) without saving it - use this before putting formScript.source into update_form, to see diagnostics first.',
    inputSchema: { id: z.string().describe('The form to validate the script against (for its generated field types).'), source: z.string() },
  }, ({ id, source }) => toResult(() => api.post(`/api/forms/${encodeURIComponent(id)}/script/check`, { source })));

  server.registerTool('list_templates', {
    title: 'List imported openEHR WebTemplates',
    description: 'Lists openEHR WebTemplates already imported into Forms. A form\'s sourceTemplates reference these by id - a template must be imported here before a form can bind fields to it.',
    inputSchema: {},
  }, () => toResult(() => api.get('/api/templates')));

  server.registerTool('list_remote_templates', {
    title: 'List WebTemplates available on the active EHRbase',
    description: 'Lists openEHR WebTemplates available on the currently configured EHRbase connection but not yet imported into Forms.',
    inputSchema: {},
  }, () => toResult(() => api.get('/api/templates/remote')));

  server.registerTool('import_remote_template', {
    title: 'Import a WebTemplate from EHRbase',
    description: 'Imports one openEHR WebTemplate from the active EHRbase connection into Forms, making it available as a sourceTemplate for forms and generate_form_from_template.',
    inputSchema: { templateId: z.string() },
  }, ({ templateId }) => toResult(() => api.post(`/api/templates/remote/${encodeURIComponent(templateId)}/import`)));

  server.registerTool('get_template_fields', {
    title: 'Get a template\'s available fields',
    description: 'Lists the openEHR paths/RM types/field metadata available on an imported WebTemplate - use this to know what a form\'s fields can bind to before writing bindings in update_form.',
    inputSchema: { id: z.string().describe('The imported template\'s id (see list_templates).') },
  }, ({ id }) => toResult(() => api.get(`/api/templates/${encodeURIComponent(id)}/fields`)));

  server.registerTool('apply_template_to_form', {
    title: 'Re-apply a WebTemplate to an existing form',
    description: 'Regenerates an existing form\'s layout/bindings from an imported WebTemplate, keeping its name, settings, extensions, and formScript. Use for adopting a changed/different template on a form you already started, as an alternative to hand-editing bindings via update_form.',
    inputSchema: { id: z.string().describe('The form to regenerate.'), templateId: z.string() },
  }, ({ id, templateId }) => toResult(() => api.post(`/api/forms/${encodeURIComponent(id)}/apply-template`, { templateId })));

  server.registerTool('generate_form_from_template', {
    title: 'Generate a starter form from a WebTemplate',
    description: 'Creates a new draft form with a layout and bindings auto-generated to cover every field of an imported WebTemplate - a faster starting point than create_form + hand-written bindings for straightforward forms.',
    inputSchema: { templateId: z.string(), formName: z.string().optional() },
  }, ({ templateId, formName }) => toResult(() => api.post('/api/forms/generate-from-template', { templateId, formName })));

  server.registerTool('audit_form_bindings', {
    title: 'Audit a form\'s bindings against the current live template',
    description: 'Checks a Form Section\'s stored bindings against the CURRENT state of its source template, fetched live from EHRbase (not the possibly-stale local import cache - re-import first with import_remote_template if you want the audit itself to reflect a template change you just made on EHRbase). A binding is a snapshot taken when the form was built or last regenerated; it never updates itself. Flags: unresolved-path (the archetype path no longer exists in the template - re-versioned or restructured), rmtype-mismatch (the RM type at that path changed), and stale-option (a stored DV_CODED_TEXT/CODE_PHRASE option is no longer a valid code - EHRbase would reject a submission that picks it). Read-only - never modifies the form or the template. Deliberately does not flag "should this now be a repeatable group" - apply_template_to_form is the authoritative fix for that class of drift, not this audit.',
    inputSchema: { id: z.string().describe('The form to audit.') },
  }, ({ id }) => toResult(() => api.get(`/api/forms/${encodeURIComponent(id)}/audit-bindings`)));
}
