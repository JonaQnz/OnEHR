import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ehrbaseClient } from '../ehrbaseClient.js';
import { toResult } from '../toolResult.js';

export function registerTemplateTools(server: McpServer): void {
  server.registerTool('list_ehrbase_templates', {
    title: 'List every template registered on the active EHRbase connection',
    description: 'GET /definition/template/adl1.4 against EHRbase directly (not via Forms). Returns every template EHRbase currently has, whether or not Forms has imported it. Start here before authoring a new template, to see what already exists and avoid a duplicate template_id/version.',
    inputSchema: {},
  }, () => toResult(() => ehrbaseClient.listTemplates()));

  server.registerTool('get_ehrbase_template_webtemplate', {
    title: 'Fetch a template as flattened WebTemplate JSON',
    description: 'GET /definition/template/adl1.4/{id} with Accept: application/openehr.wt+json. Returns the flattened field/path/RM-type structure (the same representation Forms itself reads when importing a template) - use this to inspect what a template actually looks like once EHRbase has processed it, or to sanity-check a newly uploaded one.',
    inputSchema: { templateId: z.string().describe('The template_id as EHRbase knows it, e.g. "vg_Procedure.v1.1.0" (see list_ehrbase_templates).') },
  }, ({ templateId }) => toResult(() => ehrbaseClient.getTemplateWebTemplate(templateId)));

  server.registerTool('get_ehrbase_template_opt', {
    title: 'Fetch a template\'s raw Operational Template (OPT) XML',
    description: 'GET /definition/template/adl1.4/{id} with Accept: application/xml. Returns the actual authorable artifact EHRbase stores. Fetch an existing, known-good template here first as a structural reference (correct RM/AOM shape, ontology section, ids) before composing a new one - do not write an OPT from scratch without one of these as a base.',
    inputSchema: { templateId: z.string().describe('The template_id as EHRbase knows it, e.g. "vg_Procedure.v1.1.0" (see list_ehrbase_templates).') },
  }, ({ templateId }) => toResult(() => ehrbaseClient.getTemplateOpt(templateId)));

  server.registerTool('upload_ehrbase_template', {
    title: 'Upload (register) an Operational Template with EHRbase',
    description: 'POST /definition/template/adl1.4, Content-Type: application/xml, body = the full OPT XML. This is the actual "create a new template" action - EHRbase validates the OPT itself and rejects a malformed one (4xx with the reason in the error); there is no separate design-time validator, this call IS the validation. A template id/version that already exists comes back as status "already_exists", not an error. After a successful upload, use get_ehrbase_template_webtemplate to confirm the resulting field structure, then the formbuilder MCP\'s import_remote_template to bring it into Forms.',
    inputSchema: { optXml: z.string().describe('The complete Operational Template XML document, including the XML declaration.') },
  }, ({ optXml }) => toResult(() => ehrbaseClient.uploadTemplate(optXml)));
}
