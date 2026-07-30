import { FormBuilderPlugin, JsonObject } from 'plugin-api';
import { AqlPrefillConfiguration, PrefillRuntimeContext } from './types/aqlPrefill';
import { AqlClient } from './services/aqlClient';

import { AqlPrefillEditor as _AqlPrefillEditor } from './components/AqlPrefillEditor';
import { AqlMappingEditor as _AqlMappingEditor } from './components/AqlMappingEditor';
import { AqlTestPanel as _AqlTestPanel } from './components/AqlTestPanel';
import { FieldPrefillButton as _FieldPrefillButton, FieldPrefillStatus as _FieldPrefillStatus } from './components/FieldPrefillButton';
import { GroupPrefillButton as _GroupPrefillButton } from './components/GroupPrefillButton';
import { FormPrefillButton as _FormPrefillButton } from './components/FormPrefillButton';
import { PrefillConflictDialog as _PrefillConflictDialog, ConflictItem as _ConflictItem } from './components/PrefillConflictDialog';

export * from './types/aqlPrefill';
export * from './services/resultPathResolver';
export * from './services/ehrbaseAqlAdapter';
export * from './services/aqlClient';
export * from './utils/queryBuilder';
export * from './utils/contextKey';
export * from './state/aqlPrefillCache';
export * from './state/aqlPrefillStore';
export * from './components/AqlPrefillProvider';

export const AqlPrefillEditor = _AqlPrefillEditor;
export const AqlMappingEditor = _AqlMappingEditor;
export const AqlTestPanel = _AqlTestPanel;
export const FieldPrefillButton = _FieldPrefillButton;
export const GroupPrefillButton = _GroupPrefillButton;
export const FormPrefillButton = _FormPrefillButton;
export const PrefillConflictDialog = _PrefillConflictDialog;

export type FieldPrefillStatus = _FieldPrefillStatus;
export type ConflictItem = _ConflictItem;

export const plugin: FormBuilderPlugin = {
  manifest: {
    id: 'org.openehr.aql-prefill',
    version: '1.0.0',
    apiVersion: '1.0',
    name: 'AQL Prefill',
    description: 'Erweiterbares AQL-Prefill-Plugin für openEHR Form Builder',
    extensionPoints: ['settings', 'designer', 'runtime', 'form', 'dataProvider', 'lifecycle'],
    permissions: ['form:read', 'form:write', 'ehrbase:read', 'network:request'],
  },
  activate(context) {
    context.registerSettingsPanel({
      key: 'org.openehr.aql-prefill.settings',
      panelId: 'org.openehr.aql-prefill.settings',
      label: 'AQL-Vorbelegung',
      scope: 'form',
      propertySchema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', title: 'AQL Prefill aktivieren', default: true },
        },
      },
    });

    context.registerDesignerPanel({
      key: 'org.openehr.aql-prefill.designer',
      panelId: 'org.openehr.aql-prefill.designer',
      label: 'AQL-Vorbelegung Konfiguration',
      placement: 'right',
      propertySchema: { type: 'object' },
    });


    context.registerFormAction({
      key: 'org.openehr.aql-prefill.load',
      actionId: 'load-aql-prefill',
      label: 'Patientendaten aus HIP laden',
      placement: 'hidden',
    });

    context.registerRuntimeAction({
      key: 'org.openehr.aql-prefill.refresh',
      actionId: 'refresh-aql-prefill',
      label: 'AQL-Daten aktualisieren',
      placement: 'hidden',
    });

    context.registerRuntimeAction({
      key: 'org.openehr.aql-prefill.execute',
      actionId: 'execute-aql',
      label: 'AQL-Abfrage ausführen',
      placement: 'hidden',
    });

    const handleAqlExecution = async (actionContext: any) => {
      console.log('📥 [AQL Plugin Action Received]', {
        formId: actionContext.formId,
        patientId: actionContext.patientId,
        data: actionContext.data,
      });

      context.requirePermission('ehrbase:read');
      const data = actionContext.data || {};
      const query = typeof data.query === 'string' ? data.query : '';
      const parameters = (data.parameters && typeof data.parameters === 'object' ? data.parameters : {}) as Record<string, unknown>;

      if (!query) {
        console.warn('⚠️ [AQL Plugin Action Error]: Query is empty');
        return { errors: [{ path: 'query', message: 'AQL query is required' }] };
      }

      const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env || {};
      const pluginSettings = actionContext.metadata?.pluginSettings as Record<string, unknown> | undefined;

      const loadHostService = (serviceName: string) => {
        try { return require(`../../apps/api/dist/services/${serviceName}`); } catch (_e) {}
        try { return require(`../../../apps/api/dist/services/${serviceName}`); } catch (_e) {}
        try { return require(`../apps/api/dist/services/${serviceName}`); } catch (_e) {}
        return undefined;
      };

      const configService = loadHostService('configService');
      const cfg = configService?.getConfig?.();
      const configuredUrl = cfg?.ehrbaseUrl;

      const ehrbaseUrl =
        (typeof pluginSettings?.ehrbaseUrl === 'string' ? pluginSettings.ehrbaseUrl : undefined) ||
        configuredUrl ||
        (env.EHRBASE_URL && !env.EHRBASE_URL.includes('localhost') && !env.EHRBASE_URL.includes('ehrbase:8080') ? env.EHRBASE_URL : undefined) ||
        'https://hip-cdr-core-ehrbase-enterprise-sandbox.sandbox.vghip.cloud/ehrbase/rest/openehr/v1';

      const customHeaders: Record<string, string> = {};
      const metaHeaders = actionContext.metadata?.headers as Record<string, string> | undefined;
      const authHeader = actionContext.metadata?.authorization || metaHeaders?.authorization || metaHeaders?.Authorization;
      if (authHeader) {
        customHeaders['Authorization'] = authHeader;
      } else if (actionContext.metadata?.authToken) {
        customHeaders['Authorization'] = `Bearer ${actionContext.metadata.authToken}`;
      } else if (actionContext.metadata?.bearerToken) {
        customHeaders['Authorization'] = `Bearer ${actionContext.metadata.bearerToken}`;
      }

      // Auto-fetch valid token if running in backend server environment without Authorization header
      if (!customHeaders['Authorization']) {
        const authService = loadHostService('authService');
        if (cfg?.authMode === 'keycloak' && authService?.getValidToken) {
          try {
            const token = await authService.getValidToken();
            if (token) customHeaders['Authorization'] = `Bearer ${token}`;
          } catch (err) {
            console.warn('⚠️ [AQL Plugin] getValidToken failed:', err instanceof Error ? err.message : String(err));
          }
        } else if (cfg?.ehrbaseUser && cfg?.ehrbasePass) {
          const credentials = Buffer.from(`${cfg.ehrbaseUser}:${cfg.ehrbasePass}`).toString('base64');
          customHeaders['Authorization'] = `Basic ${credentials}`;
        }
      }

      console.log('🚀 [AQL Plugin] Executing AQL query:', {
        ehrbaseUrl,
        query,
        parameters,
        hasAuthHeader: Boolean(customHeaders['Authorization']),
      });

      try {
        const client = new AqlClient({ baseUrl: ehrbaseUrl.replace(/\/$/, '') });
        const rawResult = await client.executeQuery({ query, parameters }, customHeaders);
        console.log('✅ [AQL Plugin] AQL Execution Succeeded');
        return {
          data: {
            rawResult: rawResult as unknown as JsonObject,
            query,
            parameters: parameters as unknown as JsonObject,
          },
          message: 'AQL-Abfrage erfolgreich ausgeführt.',
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('❌ [AQL Plugin Action Exception]:', error);
        return {
          errors: [{ path: 'aql', message: msg }],
        };
      }
    };

    context.registerAction('execute-aql', handleAqlExecution);
    context.registerAction('refresh-aql-prefill', handleAqlExecution);
    context.registerAction('load-aql-prefill', handleAqlExecution);

    // Lifecycle hook for automatic prefilling before form load/render
    context.registerHook('afterFormLoad', async (hookContext) => {
      const formSettings = hookContext.form.settings as Record<string, unknown> | undefined;
      const aqlConfig = formSettings?.aqlPrefill as AqlPrefillConfiguration | undefined;

      if (!aqlConfig || aqlConfig.executionMode !== 'automatic') {
        return {};
      }

      const runtimeContext: PrefillRuntimeContext = {
        patientId: hookContext.patientId,
        formValues: (hookContext.data || {}) as Record<string, unknown>,
      };

      try {
        const client = new AqlClient();
        const { loadAqlPrefillData } = await import('./state/aqlPrefillStore');
        const result = await loadAqlPrefillData(aqlConfig, runtimeContext, {
          client,
          currentValues: (hookContext.data || {}) as Record<string, unknown>,
        });

        if (result.applyResult?.success) {
          return {
            data: result.applyResult.updatedValues as unknown as JsonObject,
            notices: [{ severity: 'info', message: 'Formular automatisch per AQL vorgebelegt.' }],
          };
        }
      } catch (error) {
        return {
          warnings: [{ severity: 'warning', message: `Automatische AQL-Vorbelegung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }

      return {};
    });
  },
};

export function registerFrontendPlugin(register: (ext: any) => void) {
  // We dynamically import to avoid loading React logic in the backend if this file is required by Node
  import('./components/AqlPrefillProvider').then((mod) => {
    register({ pluginId: 'org.openehr.aql-prefill', slot: 'form:wrapper', component: mod.AqlPrefillProvider });
    register({ pluginId: 'org.openehr.aql-prefill', slot: 'form:field:actions', component: mod.AqlFieldActionWrapper });
    register({ pluginId: 'org.openehr.aql-prefill', slot: 'form:group:actions', component: mod.AqlGroupActionWrapper });
    register({ pluginId: 'org.openehr.aql-prefill', slot: 'form:header:actions', component: mod.AqlFormActionWrapper });
  }).catch(console.error);
}

export default plugin;
