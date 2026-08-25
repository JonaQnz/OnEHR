import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FormbuilderApiClient } from '../apiClient.js';
import { toResult } from '../toolResult.js';

/** Clinical data widgets: read-only "show me patient data" cards (metric,
 * table, line/area/bar chart, text) that get dropped onto a Composition
 * page as a `data` block. A widget is just a saved AQL Function (the query)
 * plus a display mapping (which named `AS alias` column is the value/label/
 * time) - the AQL Function is its own reusable object, shared across
 * widgets, so these tools cover both. Unlike form fields, a widget never
 * writes anything back; it only ever queries EHRbase for an existing
 * patient's ehrId. */
export function registerWidgetTools(server: McpServer, api: FormbuilderApiClient): void {
  server.registerTool('list_aql_functions', {
    title: 'List saved AQL functions (queries)',
    description: 'Lists every AQL "Query" widgets/plugins can bind to. These are real queries stored on EHRbase\'s own Query Service (/definition/query), not free text in Forms\' database - this list is loaded live from there (any query already defined on EHRbase shows up here too, even one Forms never created) and merged with the local description/parameters/autoload metadata EHRbase\'s model doesn\'t have. `ehrbaseVersion` is the latest version EHRbase reports for that name. Distinct from run_aql_query\'s one-off ad-hoc queries, which are never persisted anywhere.',
    inputSchema: {},
  }, () => toResult(() => api.get('/api/functions/aql')));

  server.registerTool('create_aql_function', {
    title: 'Create a saved AQL function (query)',
    description: 'Defines a new query directly on EHRbase\'s Query Service under `packageName::name` (a real PUT to /definition/query there, not just a local save) and saves its description/parameters/autoload locally. Use :patientId/:patientNamespace/:ehrId as placeholders for patient-scoped queries (translated to EHRbase\'s own $paramName binding automatically) - the same context a widget or form-runtime execution supplies - and give every result column you want to bind to an explicit `AS alias`, since a widget can only map named aliases, never positional columns. Test the query with run_aql_query first (supplying a real ehrId) to confirm it returns the shape you expect. EHRbase query definitions are permanent once created (see delete_aql_function).',
    inputSchema: {
      packageName: z.string().describe('Grouping namespace, e.g. "custom" or a plugin id. Letters/digits/hyphens/underscores.'),
      name: z.string().describe('Unique within packageName. Letters/digits/hyphens/underscores.'),
      description: z.string().optional(),
      query: z.string().describe('An AQL SELECT query with named `AS alias` result columns and :paramName placeholders.'),
      enabled: z.boolean().optional(),
    },
  }, (input) => toResult(() => api.post('/api/functions/aql', input)));

  server.registerTool('update_aql_function', {
    title: 'Update a saved AQL function (query)',
    description: 'Re-PUTs this query\'s text to EHRbase under the same name - EHRbase auto-bumps the version (e.g. 1.0.0 -> 2.0.0) and keeps the old version retrievable forever, it does not overwrite in place. Any widget already bound to this function picks up the new version on its next execution - a broken edit (e.g. dropping an `AS alias` a widget maps to) surfaces as that widget\'s query_data_widget failing, not here. packageName/name cannot be changed (EHRbase queries are permanent per name); pass the existing values back.',
    inputSchema: {
      id: z.string(),
      packageName: z.string(),
      name: z.string(),
      description: z.string().optional(),
      query: z.string(),
      enabled: z.boolean().optional(),
    },
  }, ({ id, ...body }) => toResult(() => api.put(`/api/functions/aql/${encodeURIComponent(id)}`, body)));

  server.registerTool('delete_aql_function', {
    title: 'Remove a saved AQL function (query) from Forms',
    description: 'Removes Forms\' local reference to this query only - EHRbase\'s own Query Service has no delete operation, so the actual query definition stays on EHRbase permanently regardless. If it\'s still defined there, list_aql_functions will simply rediscover and re-list it (with description/parameters reset to defaults) next time it\'s called. To stop a query from being usable without it reappearing, update_aql_function with enabled:false instead - that\'s the durable "off" switch.',
    inputSchema: { id: z.string() },
  }, ({ id }) => toResult(() => api.delete(`/api/functions/aql/${encodeURIComponent(id)}`)));

  server.registerTool('list_data_widgets', {
    title: 'List clinical data widgets',
    description: 'Lists every configured data widget (name, display type, bound AQL function, column mapping, reference range). A widget\'s id is what a Composition places into a page: edit the Composition form\'s canonical_json.extensions["watehr.composition"].pages[].blocks (via get_form/update_form) to add a block of shape { type: "data", widgetId, display, valueColumn?, labelColumn?, timeColumn?, chartType?, limit?, referenceRange? } plus a matching layout entry - there is no separate runtime "attach widget" call the way form blocks use attach_composition_block.',
    inputSchema: {},
  }, () => toResult(() => api.get('/api/widgets')));

  server.registerTool('create_data_widget', {
    title: 'Create a clinical data widget',
    description: 'Creates a new data widget bound to an existing AQL Function (create_aql_function first if needed). `configuration.display` picks the shape: "metric" (one number), "table" (rows), "line"/"area"/"bar" (chart - these require timeColumn/labelColumn respectively), or "text". valueColumn/labelColumn/timeColumn must each be a literal `AS alias` the bound AQL query actually returns - the server rejects anything else. Once saved, use query_data_widget against a real patient to see and sanity-check the actual data before wiring it into a Composition.',
    inputSchema: {
      name: z.string(),
      description: z.string().optional(),
      aqlFunctionId: z.string().describe('id of an existing AQL Function (see list_aql_functions/create_aql_function).'),
      enabled: z.boolean().optional(),
      configuration: z.object({
        display: z.enum(['metric', 'table', 'line', 'bar', 'area', 'text']),
        valueColumn: z.string().optional().describe('Required for metric/line/area/bar - the AQL result alias holding the value.'),
        labelColumn: z.string().optional().describe('Required for bar - the AQL result alias holding the category label.'),
        timeColumn: z.string().optional().describe('Required for line/area - the AQL result alias holding the timestamp.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Max rows returned, default 100.'),
        referenceRange: z.object({ min: z.number().optional(), max: z.number().optional(), criticalLow: z.number().optional(), criticalHigh: z.number().optional() }).optional().describe('Optional normal/critical band for metric/line/area widgets - drives the warning/critical color in the UI.'),
        packageName: z.string().optional().describe('Cosmetic grouping shown in the Widgets admin sidebar.'),
      }),
    },
  }, (input) => toResult(() => api.post('/api/widgets', input)));

  server.registerTool('update_data_widget', {
    title: 'Update a clinical data widget',
    description: 'Replaces a data widget\'s definition (same shape as create_data_widget). Get the current definition from list_data_widgets first if you\'re changing only part of it, since this is a full replace.',
    inputSchema: {
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      aqlFunctionId: z.string(),
      enabled: z.boolean().optional(),
      configuration: z.object({
        display: z.enum(['metric', 'table', 'line', 'bar', 'area', 'text']),
        valueColumn: z.string().optional(),
        labelColumn: z.string().optional(),
        timeColumn: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        referenceRange: z.object({ min: z.number().optional(), max: z.number().optional(), criticalLow: z.number().optional(), criticalHigh: z.number().optional() }).optional(),
        packageName: z.string().optional(),
      }),
    },
  }, ({ id, ...body }) => toResult(() => api.put(`/api/widgets/${encodeURIComponent(id)}`, body)));

  server.registerTool('delete_data_widget', {
    title: 'Delete a clinical data widget',
    description: 'Deletes a data widget. Any Composition data block still referencing its id will fail to load - update or remove that block first.',
    inputSchema: { id: z.string() },
  }, ({ id }) => toResult(() => api.delete(`/api/widgets/${encodeURIComponent(id)}`)));

  server.registerTool('query_data_widget', {
    title: 'Run a widget\'s query against a real patient',
    description: 'Executes a data widget\'s bound AQL Function for one real patient and returns the widget definition plus the resulting rows (already truncated to its configured limit) - this is the actual data a Composition\'s data block would render. Use this to test/refine a new widget before ever putting it in front of a browser: check the rows look right, then (if you also want the rendered visual) attach it to a Composition page as a data block and view/screenshot that Composition\'s runtime.',
    inputSchema: {
      id: z.string().describe('The data widget id.'),
      patientId: z.string().describe('Forms patient id or external patientId (resolved server-side, same as launch_form).'),
      patientNamespace: z.string().optional(),
    },
  }, ({ id, patientId, patientNamespace }) => toResult(() => api.post(`/api/widgets/${encodeURIComponent(id)}/query`, { patientId, ...(patientNamespace ? { patientNamespace } : {}) })));

  server.registerTool('list_widget_packages', {
    title: 'List widget packages available to the Composition designer',
    description: 'Lists widget packages the Composition Builder can offer as draggable data cards: both plugin-declared widget contributions and the technical Widgets admin\'s own saved widgets (grouped as "watehr:custom-widgets"). Each entry\'s `available` flag reflects whether its backing AQL Function actually exists and is enabled.',
    inputSchema: {},
  }, () => toResult(() => api.get('/api/plugins/widget-packages')));
}
