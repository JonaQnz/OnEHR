import { useState } from 'react';

/**
 * Shown when one or more `field(id).prefill(...)` calls from a Form
 * Script's `beforeLoad` would overwrite a field that already carries a
 * clinician's own entry (not a value from a previous prefill run - see
 * formScript.worker.ts's `provenance` map, which is what makes that
 * distinction). Ported from the old `formbuilder-plugin-aql-prefill`
 * package's `PrefillConflictDialog` - that component's UX was already
 * solid (keep/overwrite-all/select-individually), it just lived in a
 * plugin; this is the same behavior as a core, built-in part of
 * FormRuntime.tsx instead. See docs/features/aql-prefill.md.
 */
export interface PrefillConflictItem {
  requestId: string;
  fieldId: string;
  fieldLabel?: string;
  currentValue: unknown;
  prefillValue: unknown;
}

export interface PrefillConflictDialogProps {
  conflicts: PrefillConflictItem[];
  onResolve: (resolutions: Array<{ requestId: string; apply: boolean }>) => void;
}

function formatVal(val: unknown): string {
  if (val === undefined || val === null || val === '') return '(leer)';
  if (typeof val === 'object') {
    const rec = val as Record<string, unknown>;
    if (rec.magnitude !== undefined) return `${rec.magnitude} ${rec.unit || ''}`.trim();
    return JSON.stringify(val);
  }
  return String(val);
}

export function PrefillConflictDialog({ conflicts, onResolve }: PrefillConflictDialogProps) {
  const [selectedForOverwrite, setSelectedForOverwrite] = useState<Set<string>>(
    () => new Set(conflicts.map((c) => c.requestId)),
  );

  if (conflicts.length === 0) return null;

  const toggleField = (requestId: string) => {
    setSelectedForOverwrite((current) => {
      const next = new Set(current);
      if (next.has(requestId)) next.delete(requestId); else next.add(requestId);
      return next;
    });
  };

  const resolveAll = (apply: boolean) => onResolve(conflicts.map((item) => ({ requestId: item.requestId, apply })));
  const resolveIndividual = () => onResolve(conflicts.map((item) => ({ requestId: item.requestId, apply: selectedForOverwrite.has(item.requestId) })));

  return (
    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(15, 23, 42, 0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '1rem' }}>
      <div style={{ background: 'var(--surface, #ffffff)', borderRadius: '12px', padding: '1.5rem', maxWidth: '540px', width: '100%', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)' }}>
        <h3 style={{ margin: '0 0 0.5rem 0', color: 'var(--text-main, #0f172a)', fontSize: '1.1rem' }}>Konflikt beim Vorbelegen</h3>
        <p style={{ margin: '0 0 1rem 0', color: 'var(--text-muted, #475569)', fontSize: '0.85rem' }}>
          {conflicts.length === 1 ? 'Dieses Feld enthält' : 'Folgende Felder enthalten'} bereits eine manuelle Eingabe. Bitte wähle, wie damit umgegangen werden soll:
        </p>
        <div style={{ maxHeight: '240px', overflowY: 'auto', marginBottom: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {conflicts.map((item) => (
            <div key={item.requestId} style={{ padding: '0.75rem', border: '1px solid var(--border, #e2e8f0)', borderRadius: '8px', background: 'var(--surface-muted, #f8fafc)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                <strong style={{ fontSize: '0.85rem', color: 'var(--text-main, #1e293b)' }}>{item.fieldLabel || item.fieldId}</strong>
                <label style={{ fontSize: '0.75rem', color: '#2563eb', display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer' }}>
                  <input type="checkbox" checked={selectedForOverwrite.has(item.requestId)} onChange={() => toggleField(item.requestId)} />
                  Überschreiben
                </label>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.8rem' }}>
                <div style={{ color: '#dc2626' }}><strong>Aktuell:</strong> {formatVal(item.currentValue)}</div>
                <div style={{ color: '#16a34a' }}><strong>Aus AQL:</strong> {formatVal(item.prefillValue)}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button type="button" onClick={() => resolveAll(false)} style={{ padding: '0.5rem 0.85rem', fontSize: '0.82rem', borderRadius: '6px', border: '1px solid #cbd5e1', background: '#ffffff', color: '#1e293b', fontWeight: 600, cursor: 'pointer' }}>
            Manuelle Werte behalten
          </button>
          <button type="button" onClick={resolveIndividual} style={{ padding: '0.5rem 0.85rem', fontSize: '0.82rem', borderRadius: '6px', border: '1px solid #93c5fd', background: '#eff6ff', color: '#1d4ed8', fontWeight: 600, cursor: 'pointer' }}>
            Auswahl übernehmen
          </button>
          <button type="button" onClick={() => resolveAll(true)} style={{ padding: '0.5rem 0.85rem', fontSize: '0.82rem', borderRadius: '6px', border: 'none', background: '#dc2626', color: '#ffffff', fontWeight: 600, cursor: 'pointer' }}>
            Werte aus AQL übernehmen
          </button>
        </div>
      </div>
    </div>
  );
}
