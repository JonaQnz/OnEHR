import { useEffect, useState } from 'react';
import { getGeneratedValues, getTimeline, setGeneratedValues, type TimelineEntry } from '../api/client';

/**
 * Spec section 28C - a chronological list of the scenario's own events
 * ("14:32 Patient trifft ein", ...), clickable to reveal the event's raw
 * scenario data (diagnosis text, vitals, ...). Distinct from the Activity
 * view (App.tsx's own "Activity" section, worldState.activityLog) - that one
 * is the free-form technical/clinical reasoning trail behind every HIP
 * write; this one is purely the scenario's own planned timeline and whether/
 * when each step actually ran in THIS run.
 */
const EVENT_LABELS: Record<string, string> = {
  'patient-arrival': 'Patient trifft ein',
  anamnesis: 'Anamnese erhoben',
  'vital-signs': 'Vitalzeichen erfasst',
  'request-imaging': 'Bildgebung angefordert',
};

function formatTime(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function toDatetimeLocal(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function fromDatetimeLocal(value: string): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

const inputStyle = { padding: '0.35rem 0.55rem', border: '1px solid #cbd5e1', borderRadius: '5px', fontSize: '0.8rem', width: '100%' };

/**
 * The "be the agent, not an API key" mechanism's own UI surface
 * (scenario/generatedValues.ts's own doc comment) - lets a person acting as
 * the agent for the upcoming `request-imaging` event supply the same
 * GENERATED-policy values an LLM call would otherwise have produced
 * (service name, slot time, appointment comment), BEFORE stepping it.
 * Field names here are exactly what scenario/engine.ts's request-imaging
 * handler reads - this form is deliberately only shown for that one event
 * type, matching the engine's own equally explicit, non-generic handling.
 */
function RequestImagingOverrides({ scenarioRunId, eventId }: { scenarioRunId: string; eventId: string }) {
  const [healthcareServiceName, setHealthcareServiceName] = useState('');
  const [slotStart, setSlotStart] = useState('');
  const [slotEnd, setSlotEnd] = useState('');
  const [appointmentComment, setAppointmentComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getGeneratedValues(scenarioRunId, eventId)
      .then((values) => {
        if (cancelled) return;
        if (typeof values.healthcareServiceName === 'string') setHealthcareServiceName(values.healthcareServiceName);
        if (typeof values.slotStart === 'string') setSlotStart(toDatetimeLocal(values.slotStart));
        if (typeof values.slotEnd === 'string') setSlotEnd(toDatetimeLocal(values.slotEnd));
        if (typeof values.appointmentComment === 'string') setAppointmentComment(values.appointmentComment);
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scenarioRunId, eventId]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const values: Record<string, unknown> = {};
      if (healthcareServiceName) values.healthcareServiceName = healthcareServiceName;
      const start = fromDatetimeLocal(slotStart);
      const end = fromDatetimeLocal(slotEnd);
      if (start) values.slotStart = start;
      if (end) values.slotEnd = end;
      if (appointmentComment) values.appointmentComment = appointmentComment;
      await setGeneratedValues(scenarioRunId, eventId, values);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;

  return (
    <div style={{ marginTop: '0.6rem', padding: '0.65rem 0.75rem', background: '#fffbeb', border: '1px dashed #f59e0b', borderRadius: '8px' }}>
      <div style={{ fontSize: '0.72rem', fontWeight: 600, color: '#b45309', marginBottom: '0.4rem' }}>
        🤖 Als Agent handeln - Werte für diesen Schritt vorgeben (statt der eingebauten Standardwerte)
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.4rem' }}>
        <label style={{ fontSize: '0.7rem', color: '#92400e' }}>
          Fachabteilung
          <input style={inputStyle} value={healthcareServiceName} onChange={(e) => setHealthcareServiceName(e.target.value)} placeholder="CT-Diagnostik" />
        </label>
        <label style={{ fontSize: '0.7rem', color: '#92400e' }}>
          Slot-Beginn
          <input style={inputStyle} type="datetime-local" value={slotStart} onChange={(e) => setSlotStart(e.target.value)} />
        </label>
        <label style={{ fontSize: '0.7rem', color: '#92400e' }}>
          Slot-Ende
          <input style={inputStyle} type="datetime-local" value={slotEnd} onChange={(e) => setSlotEnd(e.target.value)} />
        </label>
      </div>
      <label style={{ fontSize: '0.7rem', color: '#92400e', display: 'block', marginTop: '0.4rem' }}>
        Kommentar zum Termin
        <input style={inputStyle} value={appointmentComment} onChange={(e) => setAppointmentComment(e.target.value)} placeholder="CT-Pulmonalisangiographie bei V.a. Lungenembolie" />
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
        <button type="button" className="btn" disabled={saving} onClick={save} style={{ padding: '0.3rem 0.8rem', fontSize: '0.78rem' }}>
          {saving ? '…' : 'Werte speichern'}
        </button>
        {saved && <span style={{ color: '#15803d', fontSize: '0.75rem' }}>✓ gespeichert - wird beim nächsten Step verwendet</span>}
        {error && <span style={{ color: '#b91c1c', fontSize: '0.75rem' }}>{error}</span>}
      </div>
    </div>
  );
}

export function Timeline({ scenarioRunId, refreshKey }: { scenarioRunId: string; refreshKey?: unknown }) {
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTimeline(scenarioRunId)
      .then((result) => { if (!cancelled) setTimeline(result.timeline); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [scenarioRunId, refreshKey]);

  if (error) return <p style={{ color: '#b91c1c', fontSize: '0.85rem' }}>{error}</p>;
  if (timeline.length === 0) return null;

  return (
    <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {timeline.map(({ event, completed, completedAt }) => {
        const isExpanded = expanded === event.id;
        return (
          <li key={event.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
            <button
              type="button"
              onClick={() => setExpanded((current) => (current === event.id ? null : event.id))}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.6rem', width: '100%', textAlign: 'left',
                border: 0, background: 'transparent', cursor: 'pointer', padding: '0.5rem 0', fontSize: '0.85rem',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: '0.6rem', height: '0.6rem', borderRadius: '999px', flexShrink: 0,
                  background: completed ? '#15803d' : '#cbd5e1',
                }}
              />
              <span style={{ color: '#94a3b8', fontFamily: 'monospace', fontSize: '0.78rem', width: '4.5rem', flexShrink: 0 }}>
                {completed ? formatTime(completedAt) : `~${event.at}`}
              </span>
              <span style={{ fontWeight: completed ? 600 : 400, color: completed ? '#0f172a' : '#94a3b8' }}>
                {EVENT_LABELS[event.type] ?? event.type}
              </span>
              {!completed && <span style={{ color: '#cbd5e1', fontSize: '0.75rem' }}>(ausstehend)</span>}
            </button>
            {isExpanded && (
              <div style={{ padding: '0 0 0.75rem 1.85rem', fontSize: '0.8rem', color: '#475569' }}>
                <div>Event-ID: <code>{event.id}</code></div>
                {event.data && Object.keys(event.data).length > 0 && (
                  <div style={{ marginTop: '0.25rem' }}>
                    {Object.entries(event.data).map(([key, value]) => (
                      <div key={key}>{key}: <strong>{String(value)}</strong></div>
                    ))}
                  </div>
                )}
                {!completed && event.type === 'request-imaging' && (
                  <RequestImagingOverrides scenarioRunId={scenarioRunId} eventId={event.id} />
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export default Timeline;
