import type { FormBuilderPlugin, JsonObject } from 'plugin-api';

/**
 * Backed by OpenPLZ API (https://www.openplzapi.org,
 * https://github.com/openpotato/openplzapi) - an open-source project built
 * on public administrative-boundary data (OpenStreetMap/official registers),
 * not a proprietary postal-code vendor. It's also self-hostable, so a
 * deployment that needs to keep this lookup in-house for data-sovereignty
 * reasons can run the same open-source project instead of the public
 * instance - that's the point of picking an open-source-backed API here
 * rather than a closed one.
 */
const COUNTRY_SEGMENTS: Record<string, string> = { DE: 'de', AT: 'at', CH: 'ch', LI: 'li' };
const COUNTRY_NAMES: Record<string, string> = { DE: 'Deutschland', AT: 'Österreich', CH: 'Schweiz', LI: 'Liechtenstein' };

interface OpenPlzLocality {
  postalCode?: string;
  name?: string;
  federalState?: { name?: string };
  canton?: { name?: string };
  municipality?: { name?: string };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const plugin: FormBuilderPlugin = {
  manifest: {
    id: 'org.openehr.postal-lookup',
    version: '1.0.0',
    apiVersion: '1.0',
    name: 'Postleitzahl-Nachschlage',
    description: 'Ermittelt Ort und Bundesland zu einer Postleitzahl (DE/AT/CH/LI) über die quelloffene OpenPLZ API, zum Aufruf aus einem Form Script.',
    extensionPoints: ['scripting'],
    permissions: ['network:request'],
  },
  activate(context) {
    context.registerScriptingOperation(
      {
        key: 'org.openehr.postal-lookup.lookup',
        operationId: 'lookup',
        label: 'PLZ-Nachschlage (Ort/Bundesland)',
        description: 'Liefert Ort und Bundesland zu einer Postleitzahl über die offene OpenPLZ API.',
        permissions: ['network:request'],
        inputSchema: {
          type: 'object',
          properties: {
            plz: { type: 'string', description: 'Postleitzahl' },
            country: { type: 'string', enum: ['DE', 'AT', 'CH', 'LI'], default: 'DE' },
          },
          required: ['plz'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            ort: { type: 'string' },
            bundesland: { type: 'string' },
            land: { type: 'string' },
          },
        },
      },
      async ({ data }) => {
        context.requirePermission('network:request');
        const input = (data || {}) as JsonObject;
        const plz = text(input.plz);
        if (!plz) return { errors: [{ path: 'plz', message: 'Postleitzahl fehlt.' }] };
        const country = text(input.country)?.toUpperCase() || 'DE';
        const segment = COUNTRY_SEGMENTS[country];
        if (!segment) return { errors: [{ path: 'country', message: `Land "${country}" wird nicht unterstützt (DE/AT/CH/LI).` }] };

        let response: Response;
        try {
          response = await fetch(`https://openplzapi.org/${segment}/Localities?postalCode=${encodeURIComponent(plz)}`, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(5000),
          });
        } catch (error) {
          const timedOut = error instanceof Error && /timeout|abort/i.test(error.message);
          return { errors: [{ path: 'plz', message: timedOut ? 'PLZ-Nachschlage hat nicht innerhalb von 5 Sekunden geantwortet.' : `PLZ-Nachschlage nicht erreichbar: ${error instanceof Error ? error.message : String(error)}` }] };
        }
        if (!response.ok) return { errors: [{ path: 'plz', message: `PLZ-Nachschlage antwortete mit HTTP ${response.status}.` }] };

        let localities: OpenPlzLocality[] = [];
        try { localities = (await response.json()) as OpenPlzLocality[]; } catch { return { errors: [{ path: 'plz', message: 'PLZ-Nachschlage lieferte keine gültige Antwort.' }] }; }
        if (!Array.isArray(localities) || localities.length === 0) return { errors: [{ path: 'plz', message: `Keine Ortschaft zu Postleitzahl "${plz}" gefunden.` }] };

        const match = localities[0];
        const ort = text(match.name) || text(match.municipality?.name);
        const bundesland = text(match.federalState?.name) || text(match.canton?.name);
        return { data: { ort: ort || '', bundesland: bundesland || '', land: COUNTRY_NAMES[country] } };
      },
    );
  },
};

export default plugin;
