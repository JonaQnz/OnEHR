import { FormBuilderPlugin, JsonObject, JsonValue } from 'plugin-api';

const plugin: FormBuilderPlugin = {
  manifest: {
    id: 'org.example.vitals',
    version: '1.0.0',
    apiVersion: '1.0',
    name: 'Example Vitals',
    description: 'A tiny plugin used to verify loading, settings, fields, actions, and hooks.',
    extensionPoints: ['field', 'settings', 'form', 'designer', 'runtime', 'dataProvider', 'lifecycle', 'widget'],
    permissions: ['form:read', 'form:write', 'ehrbase:read'],
  },
  activate(context) {
    context.registerFieldType({
      key: 'org.example.vitals.quantity',
      fieldType: 'input-quantity',
      label: 'Example vital quantity',
      propertySchema: { type: 'object' },
    });
    context.registerSettingsPanel({
      key: 'org.example.vitals.settings',
      panelId: 'org.example.vitals.settings',
      label: 'Example Vitals settings',
      propertySchema: { type: 'object' },
    });
    context.registerFormAction({
      key: 'org.example.vitals.check',
      actionId: 'org.example.vitals.check',
      label: 'Check vitals',
      placement: 'toolbar',
    });
    context.registerDesignerPanel({
      key: 'org.example.vitals.designer',
      panelId: 'org.example.vitals.designer',
      label: 'Example Vitals designer',
      placement: 'right',
      propertySchema: { type: 'object' },
    });
    context.registerRuntimeAction({
      key: 'org.example.vitals.runtime',
      actionId: 'org.example.vitals.runtime',
      label: 'Recalculate vitals',
      placement: 'toolbar',
    });
    context.registerDataProvider({
      key: 'org.example.vitals.provider',
      providerId: 'org.example.vitals.provider',
      label: 'Example Vitals provider',
      capabilities: ['load'],
    });
    context.registerWidgetPackage({
      key: 'org.example.vitals.clinical',
      packageId: 'clinical',
      label: 'Klinische Übersicht',
      widgets: [
        {
          id: 'laboratory-analytes', title: 'Laborwerte im Verlauf',
          aqlFunction: { packageName: 'laboratory', name: 'analyteResults' },
          requiredContext: ['ehrId'],
          columns: { value: 'magnitude', label: 'analyteName', time: 'recordedAt', unit: 'unit' },
          chart: { type: 'line', x: 'recordedAt', y: 'magnitude' },
        },
        {
          id: 'recent-laboratory-reports', title: 'Aktuelle Laborbefunde',
          aqlFunction: { packageName: 'laboratory', name: 'labReportTimeline' },
          requiredContext: ['ehrId'],
          columns: { value: 'entryName', label: 'recordedAt', time: 'recordedAt' },
          chart: { type: 'table' },
        },
        {
          id: 'recent-diagnoses', title: 'Aktuelle Diagnosen',
          aqlFunction: { packageName: 'clinicalOverview', name: 'diagnosisHistory' },
          requiredContext: ['ehrId'],
          columns: { value: 'entryName', label: 'recordedAt', time: 'recordedAt' },
          chart: { type: 'table' },
        },
      ],
    });
    context.registerHook('beforeFormSave', ({ data }) => {
      const currentExtensions = data?.extensions;
      const extensions: Record<string, JsonValue> = currentExtensions && typeof currentExtensions === 'object' && !Array.isArray(currentExtensions)
        ? currentExtensions as Record<string, JsonValue>
        : {};
      const marker: JsonObject = { checked: true, plugin: 'org.example.vitals' };
      return { data: { ...(data || {}), extensions: { ...extensions, 'org.example.vitals': marker } } };
    });
  },
};

export default plugin;
