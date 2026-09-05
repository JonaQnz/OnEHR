import type { FormBuilderPlugin, PluginActivationContext } from 'plugin-api';
import type { TerminologyProvider } from 'core';
import { FhirClient } from './fhirClient';
import * as ops from './terminologyProvider';
import { createManage } from './manage';

function environment(name: string): string | undefined {
  const processLike = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process;
  const value = processLike?.env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function baseUrl(settings: Record<string, unknown>): string {
  return (text(settings.baseUrl) || environment('TERMINOLOGY_SERVER_URL') || 'http://terminology:8080/fhir').replace(/\/$/, '');
}

function canonicalBase(settings: Record<string, unknown>): string {
  return text(settings.customTerminologyCanonicalBase) || environment('TERMINOLOGY_CUSTOM_CANONICAL_BASE') || 'urn:formbuilder:custom';
}

/**
 * Registers a live `TerminologyProvider` for a self-hosted HAPI FHIR JPA
 * terminology server - `context.registerTerminologyProvider(...)`, the same
 * shape/purpose as `example-n8n-plugin`'s
 * `context.registerFormDataProvider(...)`. See this package's README-level
 * doc comment in `manage.ts` for the FHIR modeling decisions behind custom
 * terminology lifecycle/versioning.
 */
function createHapiTerminologyProvider(context: PluginActivationContext): TerminologyProvider {
  const client = () => new FhirClient(baseUrl(context.getSettings()), context.logger);
  return {
    id: 'hapi-terminology',
    displayName: 'HAPI FHIR Terminology Server',
    capabilities: ['search', 'lookup', 'validate', 'discover', 'manage'],
    search: (input) => ops.search(client(), input),
    lookup: (input) => ops.lookup(client(), input),
    validate: (input) => ops.validate(client(), input),
    discover: {
      searchBindings: (query) => ops.searchBindings(client(), query),
      getBinding: (bindingId, bindingVersion) => ops.getBinding(client(), bindingId, bindingVersion),
    },
    // `client` (not `client()`) - createManage calls this fresh on every
    // manage.* invocation, so a later settings change takes effect
    // immediately, same as search/lookup/validate/discover above.
    manage: createManage(client, () => canonicalBase(context.getSettings())),
  };
}

const plugin: FormBuilderPlugin = {
  manifest: {
    id: 'hapi-terminology',
    version: '1.0.0',
    apiVersion: '1.0',
    name: 'HAPI Terminology Server',
    description: 'Search, validate, and self-author terminologies (ICD-10-GM, OPS, SNOMED CT, LOINC, and organization-defined lists) against a self-hosted HAPI FHIR JPA server.',
    extensionPoints: ['settings', 'terminology'],
    // Documents the outbound HTTP this plugin makes (fhirClient.ts) - not
    // sandbox-enforced (plugins run in-process, see PluginRegistry's own
    // doc comment), but every other network-calling plugin in this repo
    // (example-n8n-plugin) declares this too, so the Plugins page's
    // permission listing stays an accurate picture of what's actually
    // happening, not just what's technically blocked.
    permissions: ['network:request'],
  },
  activate(context) {
    context.registerSettingsPanel({
      key: 'hapi-terminology-connection',
      panelId: 'formbuilder.hapi-terminology.connection',
      label: 'HAPI Terminologie-Server',
      scope: 'global',
      propertySchema: {
        type: 'object',
        properties: {
          baseUrl: { type: 'string', title: 'HAPI FHIR Basis-URL', format: 'uri', default: 'http://terminology:8080/fhir', description: 'Docker: http://terminology:8080/fhir (Compose-Servicename); lokal: http://localhost:8081/fhir' },
          customTerminologyCanonicalBase: { type: 'string', title: 'Canonical-Base für eigene Terminologien', format: 'uri', description: 'z. B. https://forms.ihre-organisation.de/terminology - erzeugt stabile <base>/CodeSystem/<id>-Canonicals. Leer lassen für einen lokalen urn:formbuilder:custom:-Fallback (nur für Entwicklung geeignet).' },
        },
      },
    });
    context.registerTerminologyProvider(createHapiTerminologyProvider(context));
  },
};

export default plugin;
