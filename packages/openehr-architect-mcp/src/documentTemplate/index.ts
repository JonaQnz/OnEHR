/** Barrel export so this module can be consumed as a plain library import
 * from another workspace package (see packages/mcp-server's
 * pack_forms_into_document_template tool) without pulling in this package's
 * own `main` entry (src/index.ts), which is an MCP server executable that
 * starts a stdio transport as a side effect on import - never something a
 * library consumer should trigger. */
export * from './types.js';
export * from './componentResolver.js';
export * from './operationalTemplateCompiler.js';
export * from './documentTemplateService.js';
export * from './formComponents.js';
