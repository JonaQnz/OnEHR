import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { composeDocumentTemplate } from '../documentTemplate/documentTemplateService.js';
import { toResult } from '../toolResult.js';

const documentComponentSchema = z.object({
  sourceTemplateId: z.string().describe('An already-registered EHRbase template_id to pull a reusable component from, e.g. "vg_Diagnosis.v1.1.1" (see list_ehrbase_templates).'),
  sourceArchetypeId: z.string().describe('The full archetype_id of the specific C_ARCHETYPE_ROOT to extract from that template, e.g. "openEHR-EHR-EVALUATION.problem_diagnosis.v1" - an archetype boundary, not an arbitrary path. Inspect the source template with get_ehrbase_template_opt first if unsure which archetype_id(s) it contains.'),
  sourceName: z.string().optional().describe('Disambiguates when the source template uses the same archetype_id more than once (a real, confirmed case: vg_Diagnosis.v1.1.1 uses EVALUATION.problem_diagnosis.v1 for both "primary diagnosis" and "secondary diagnosis") - the archetype\'s own `name/value` constraint text, the same disambiguator openEHR\'s own AQL paths use. Omit on the first attempt; if the archetype_id is ambiguous the error message lists the available values to pass here.'),
  label: z.string().describe('Display name / SECTION label for this component in the new document, e.g. "Diagnosen".'),
  wrapInSection: z.boolean().optional().describe('When true, wraps this component in a new, compiler-authored ad-hoc SECTION so it gets a labeled grouping in the assembled document even though the source archetype itself is not already a SECTION (the common case). Leave false/unset if the component is already a SECTION or should hang directly off the document root.'),
});

export function registerDocumentTemplateTools(server: McpServer): void {
  server.registerTool('compose_document_template', {
    title: 'Compose a new OPT from reusable Document Components already published on EHRbase',
    description: 'DocumentTemplate -> ComponentResolver -> ComponentProjection[] -> OperationalTemplateCompiler -> OPT -> upload_ehrbase_template, in one call. NOT a general ADL2/AOM2 slot-filling engine - a narrow, pragmatic compiler that reuses already-published, already-uploaded single-archetype OPTs (e.g. from earlier get_ehrbase_template_opt/upload_ehrbase_template authoring) as content building blocks for one new document, wrapping each in a COMPOSITION.report.v1 root. Each component\'s own at-codes/term_definitions are carried over completely unchanged (at-codes are scoped per archetype terminology, never renumbered). Only SECTION/OBSERVATION/EVALUATION/ACTION/INSTRUCTION/ADMIN_ENTRY archetype roots are accepted as top-level components - a CLUSTER/ITEM_TREE/ELEMENT sourceArchetypeId is rejected with a clear error, since those are parts within an Entry/Section, not standalone document building blocks. After a successful call, use get_ehrbase_template_webtemplate to confirm the resulting field structure, then the formbuilder MCP\'s import_remote_template + generate_form_from_template to bring it into Forms.',
    inputSchema: {
      templateId: z.string().describe('New template_id to register on EHRbase, e.g. "entlassbrief_v1". Must not already exist (see list_ehrbase_templates).'),
      name: z.string().describe('Root COMPOSITION display name, e.g. "Entlassbrief".'),
      purpose: z.string().describe('Human-readable purpose stored in the OPT itself, e.g. what document this composes and from which components.'),
      components: z.array(documentComponentSchema).min(1).describe('The reusable building blocks to compose, in the order they should appear in the document.'),
    },
  }, ({ templateId, name, purpose, components }) => toResult(() => composeDocumentTemplate({ templateId, name, purpose, components })));
}
