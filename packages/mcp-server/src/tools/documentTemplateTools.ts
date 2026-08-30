import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FormbuilderApiClient } from '../apiClient.js';
import { toResult } from '../toolResult.js';
import { composeDocumentTemplate, deriveDocumentComponents, type DocumentComponent, type FormLike } from 'openehr-architect-mcp/dist/documentTemplate/index.js';

interface FormRecord { canonical_json: FormLike; }

/** "Pack these already-built Forms together" - the Form-level counterpart to
 * openehr-architect-mcp's archetype-level compose_document_template. Each
 * Form is fetched through this server's own, already-established Forms API
 * client (the same one every other tool here uses); deriveDocumentComponents
 * (a pure function, no HTTP of its own) turns each Form's own
 * sourceTemplates/bindings into the DocumentComponent(s) it represents, then
 * the unchanged compose_document_template pipeline does the rest (resolve
 * against the real OPTs on EHRbase, compile, upload). Deliberately does NOT
 * duplicate any Forms-API or EHRbase logic - both halves are the exact same
 * code already proven by compose_document_template, just fed from Form ids
 * instead of hand-written archetype references. */
export function registerDocumentTemplateTools(server: McpServer, api: FormbuilderApiClient): void {
  server.registerTool('pack_forms_into_document_template', {
    title: 'Pack already-built Forms into one merged Document Template on EHRbase',
    description: 'Given a list of already-built, published Forms (each normally bound to its own single-archetype template, e.g. "Diagnosen / Vorerkrankungen"), derives the openEHR component(s) each one represents from its own sourceTemplates/bindings (no manual archetype references needed - a Form binding more than one archetype, e.g. a Synopsis+Recommendation form, correctly yields more than one component) and composes them into one new, structurally correct OPT via the same pipeline compose_document_template uses (upload to EHRbase, import, generate a new Form). The original Forms are untouched - this produces a new, separate Form. Fails loudly (not silently) if a Form has other than exactly one sourceTemplates entry, or maps an archetype that is not itself a valid top-level component (CLUSTER/ITEM_TREE/ELEMENT-rooted).',
    inputSchema: {
      name: z.string().describe('Root COMPOSITION display name for the packed document, e.g. "Entlassbrief".'),
      templateId: z.string().describe('New template_id to register on EHRbase, e.g. "entlassbrief_v1". Must not already exist.'),
      purpose: z.string().describe('Human-readable purpose stored in the OPT itself.'),
      forms: z.array(z.object({
        formId: z.string().describe('The id of an already-built Form to pack in (get it via list_forms/get_form).'),
        label: z.string().optional().describe('Overrides the SECTION label for the component(s) derived from this Form. Defaults to the Form\'s own name. Required if the same Form is packed in more than once with different meanings in each placement.'),
        wrapInSection: z.boolean().optional().describe('Whether to wrap this Form\'s component(s) in a new ad-hoc SECTION for grouping. Defaults to true.'),
      })).min(1).describe('The Forms to pack, in the order they should appear in the document.'),
    },
  }, ({ name, templateId, purpose, forms }) => toResult(async () => {
    const components: DocumentComponent[] = [];
    for (const entry of forms) {
      const record = await api.get<FormRecord>(`/api/forms/${encodeURIComponent(entry.formId)}`);
      components.push(...deriveDocumentComponents(record.canonical_json, { label: entry.label, wrapInSection: entry.wrapInSection }));
    }
    return composeDocumentTemplate({ templateId, name, purpose, components });
  }));
}
