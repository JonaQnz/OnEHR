import { useState } from 'react';
import { getCapabilityEmbedUrl, type CapabilityRecord } from '../api/client';

/**
 * Embeds the REAL Form Builder to show openEHR clinical content - never a
 * second renderer for it (spec's own "keine zweite Form-Builder-UI" rule).
 * Per docs/integration/form-launch-v1.md's own embed contract: an <iframe>
 * pointed at the Form Builder web app's own `/embed/forms/:id` page. The
 * person viewing this workbench's UI must also be logged into the Form
 * Builder web app in the SAME browser for the iframe to render (its own
 * personal session, entirely separate from this backend's own service-
 * account API login) - exactly like any other page on that domain.
 *
 * Lazy: nothing is fetched/loaded until "Anzeigen" is clicked, so a
 * capability list with several entries never eagerly opens that many
 * Form-Builder sessions just to render its own card list.
 */
export function OpenEhrEmbed({ scenarioRunId, capability }: { scenarioRunId: string; capability: CapabilityRecord }) {
  const [webUrl, setWebUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    getCapabilityEmbedUrl(scenarioRunId, capability.capability)
      .then((result) => setWebUrl(result.webUrl))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  return (
    <div style={{ border: '1px solid #e2e8f0', borderRadius: '8px', padding: '0.85rem 1rem', marginBottom: '0.75rem', background: 'white' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: webUrl ? '0.75rem' : 0 }}>
        <strong>{capability.capability}</strong>
        {!webUrl && (
          <button type="button" className="btn" onClick={load} disabled={loading} style={{ padding: '0.35rem 0.9rem' }}>
            {loading ? 'Lädt…' : 'Anzeigen'}
          </button>
        )}
      </div>
      {error && (
        <p style={{ color: '#b91c1c', fontSize: '0.85rem' }}>
          {error}
          {' '}(Sind Sie im selben Browser auch im Form Builder angemeldet?)
        </p>
      )}
      {webUrl && (
        <iframe
          title={`${capability.capability} (Form Builder)`}
          src={webUrl}
          style={{ width: '100%', height: '480px', border: '1px solid #e2e8f0', borderRadius: '6px' }}
        />
      )}
    </div>
  );
}

export default OpenEhrEmbed;
