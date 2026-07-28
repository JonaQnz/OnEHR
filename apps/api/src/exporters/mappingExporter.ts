interface MappingExportForm {
  id: string;
  version: string;
  sourceTemplates: Array<{
    alias: string;
    id: string;
    version: string;
  }>;
  bindings: Record<string, { openehr?: { templateAlias?: string; path?: string; rmType?: string; flatPath?: string } }>;
}

export function exportMappings(form: MappingExportForm) {
  const mappings = Object.entries(form.bindings || {}).map(([fieldName, binding]) => ({
    fieldName,
    openehrPath: binding.openehr?.path,
    templateAlias: binding.openehr?.templateAlias,
    rmType: binding.openehr?.rmType,
    flatPath: binding.openehr?.flatPath,
  }));

  return {
    formId: form.id,
    formVersion: form.version,
    sourceTemplates: form.sourceTemplates.map((template) => ({
      alias: template.alias,
      id: template.id,
      version: template.version,
    })),
    mappings,
  };
}
