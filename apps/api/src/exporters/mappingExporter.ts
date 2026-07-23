interface MappingExportForm {
  id: string;
  version: string;
  sourceTemplates: Array<{
    alias: string;
    id: string;
    version: string;
  }>;
  fhirMappings?: Record<string, unknown>;
}

export function exportMappings(form: MappingExportForm) {
  const mappings = Object.entries(form.fhirMappings || {}).map(
    ([fieldName, value]) => {
      const mappingData = value as {
        source?: { path?: string };
        fhir?: Record<string, unknown>;
      };

      return {
        fieldName,
        openehrPath: mappingData.source?.path,
        fhirVersion: mappingData.fhir?.fhirVersion,
        standard: mappingData.fhir?.standard,
        resourceType: mappingData.fhir?.resourceType,
        profile: mappingData.fhir?.profile,
        elementPath: mappingData.fhir?.elementPath,
        code: mappingData.fhir?.code,
        unit: mappingData.fhir?.unit,
      };
    },
  );

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
