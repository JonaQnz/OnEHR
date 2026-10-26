import { useEffect, useState, type CSSProperties } from 'react';
import { createScenarioRun, getWorldState, listFacilities, listScenarioRuns, listScenarios, openFacility, type Facility, type JourneyGraphNode, type WorldState } from './api/client';
import { ResourceInspector } from './components/ResourceInspector';
import { OpenEhrEmbed } from './components/OpenEhrEmbed';
import { SimulationControls } from './components/SimulationControls';
import { Timeline } from './components/Timeline';
import { ResourceFormManager } from './components/ResourceFormManager';
import { JourneyGraph } from './components/JourneyGraph';
import { HospitalSimulation } from './components/HospitalSimulation';

/**
 * The Clinical Scenario Workbench's own UI (spec section 28/31/44). The
 * Journey Graph (components/JourneyGraph.tsx, React Flow + dagre) is the
 * centerpiece, with two levels (user's own explicit ask): "Klinik" is the
 * bird's-eye view across every case at once, hung off the shared clinic
 * capacity; "Fall" is one case's own full detail, exactly what used to be
 * the only view. Clicking a patient in the Klinik view drills down into
 * their own Fall view; clicking any node in the Fall view opens that
 * entity's own fitting detail below the graph - openEHR content by
 * embedding the real Form Builder (components/OpenEhrEmbed.tsx - never a
 * second renderer for it), FHIR resources via ResourceInspector.tsx's own
 * static-form rendering.
 */
function defaultScenarioRunId(scenarioId: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `${scenarioId}-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Mirrors backend context.ts's own DEFAULT_FACILITY_ID - the original,
 * always-open hospital every pre-existing scenario/run implicitly belongs
 * to. Duplicated here rather than shared (frontend/backend are separate
 * packages) - kept in sync by name/comment, not by import. */
const DEFAULT_FACILITY_ID = 'krankenhaus';

/** User's own ask: a page refresh should land back on the same Fall/Haus,
 * not reset to the Klinik overview - so the current facility + run + graph
 * mode live in the URL's own query string (?facility=...&run=...&mode=...),
 * not just React state. `replaceState` (not `pushState`) - this is state
 * restoration, not navigation history a user would want a Back button
 * entry for. */
function readUrlState(): { facility: string; run: string | null; mode: 'clinic' | 'case' } {
  const params = new URLSearchParams(window.location.search);
  const facility = params.get('facility') || DEFAULT_FACILITY_ID;
  const run = params.get('run');
  const mode = params.get('mode') === 'case' ? 'case' : params.get('mode') === 'clinic' ? 'clinic' : run ? 'case' : 'clinic';
  return { facility, run, mode };
}

function writeUrlState(facility: string, run: string | null, mode: 'clinic' | 'case'): void {
  const params = new URLSearchParams(window.location.search);
  if (facility && facility !== DEFAULT_FACILITY_ID) params.set('facility', facility); else params.delete('facility');
  if (run) params.set('run', run); else params.delete('run');
  params.set('mode', mode);
  const query = params.toString();
  window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
}

const selectStyle = { padding: '0.45rem 0.7rem', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '0.88rem', background: 'white' };

function NewRunForm({ facilityId, onCreated }: { facilityId: string; onCreated: (scenarioRunId: string) => void }) {
  const [scenarioIds, setScenarioIds] = useState<string[]>([]);
  const [scenarioId, setScenarioId] = useState('');
  const [scenarioRunId, setScenarioRunId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Scoped to the currently selected Haus - starting a Rehazentrum
    // scenario while looking at the Krankenhaus's Klinik view would just
    // make the new case vanish from view until switching facilities.
    listScenarios(facilityId).then(({ scenarioIds }) => {
      setScenarioIds(scenarioIds);
      if (scenarioIds[0]) {
        setScenarioId(scenarioIds[0]);
        setScenarioRunId(defaultScenarioRunId(scenarioIds[0]));
      } else {
        setScenarioId('');
        setScenarioRunId('');
      }
    }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [facilityId]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await createScenarioRun(scenarioRunId, scenarioId);
      onCreated(scenarioRunId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (scenarioIds.length === 0) {
    return <p style={{ margin: 0, color: '#94a3b8', fontSize: '0.85rem' }}>Keine Szenarien für dieses Haus hinterlegt.</p>;
  }

  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
      <select value={scenarioId} onChange={(event) => { setScenarioId(event.target.value); setScenarioRunId(defaultScenarioRunId(event.target.value)); }} style={selectStyle}>
        {scenarioIds.map((id) => <option key={id} value={id}>{id}</option>)}
      </select>
      <input
        value={scenarioRunId}
        onChange={(event) => setScenarioRunId(event.target.value)}
        style={{ ...selectStyle, flex: 1, fontFamily: 'monospace', fontSize: '0.82rem' }}
      />
      <button type="button" className="btn" disabled={busy || !scenarioId || !scenarioRunId} onClick={create}>
        {busy ? '…' : '+ Neuer Fall'}
      </button>
      {error && <span style={{ color: '#b91c1c', fontSize: '0.85rem' }}>{error}</span>}
    </div>
  );
}

/** User's own ask: "dass wir ein zweites Haus eröffnen können" - a compact
 * inline picker + "open a new one" form, same style as NewRunForm above. */
function FacilitySelector({ facilities, selectedFacility, onSelect, onOpened }: {
  facilities: Facility[];
  selectedFacility: string;
  onSelect: (facilityId: string) => void;
  onOpened: (facilityId: string) => void;
}) {
  const [showOpenForm, setShowOpenForm] = useState(false);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const facility = await openFacility(id, name);
      setShowOpenForm(false);
      setId('');
      setName('');
      onOpened(facility.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
      <select value={selectedFacility} onChange={(event) => onSelect(event.target.value)} style={selectStyle}>
        {facilities.map((facility) => <option key={facility.id} value={facility.id}>🏠 {facility.name}</option>)}
      </select>
      {!showOpenForm && (
        <button type="button" className="btn" onClick={() => setShowOpenForm(true)}>+ Neues Haus</button>
      )}
      {showOpenForm && (
        <>
          <input
            placeholder="id, z.B. rehazentrum"
            value={id}
            onChange={(event) => setId(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
            style={{ ...selectStyle, width: '10rem', fontFamily: 'monospace', fontSize: '0.82rem' }}
          />
          <input
            placeholder="Name, z.B. Rehazentrum Sonnenberg"
            value={name}
            onChange={(event) => setName(event.target.value)}
            style={{ ...selectStyle, width: '14rem' }}
          />
          <button type="button" className="btn" disabled={busy || !id || !name} onClick={open}>{busy ? '…' : 'Öffnen'}</button>
          <button type="button" className="btn" onClick={() => setShowOpenForm(false)}>Abbrechen</button>
        </>
      )}
      {error && <span style={{ color: '#b91c1c', fontSize: '0.85rem' }}>{error}</span>}
    </div>
  );
}

function GraphModeTabs({ mode, onChange, caseLabel, caseDisabled }: {
  mode: 'clinic' | 'case';
  onChange: (mode: 'clinic' | 'case') => void;
  caseLabel: string;
  caseDisabled: boolean;
}) {
  const tabStyle = (active: boolean, disabled: boolean): CSSProperties => ({
    border: 0,
    background: active ? '#0f172a' : 'transparent',
    color: active ? 'white' : disabled ? '#cbd5e1' : '#475569',
    borderRadius: '8px',
    padding: '0.4rem 0.9rem',
    fontSize: '0.85rem',
    fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer',
  });
  return (
    <div style={{ display: 'inline-flex', gap: '0.2rem', background: '#f1f5f9', borderRadius: '10px', padding: '0.2rem' }}>
      <button type="button" style={tabStyle(mode === 'clinic', false)} onClick={() => onChange('clinic')}>🏥 Klinik</button>
      <button type="button" style={tabStyle(mode === 'case', caseDisabled)} disabled={caseDisabled} onClick={() => onChange('case')}>
        🩺 {caseLabel}
      </button>
    </div>
  );
}

export default function App() {
  const [initialUrlState] = useState(readUrlState);
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [selectedFacility, setSelectedFacility] = useState(initialUrlState.facility);
  const [scenarioRuns, setScenarioRuns] = useState<string[]>([]);
  const [selectedRun, setSelectedRun] = useState<string | null>(initialUrlState.run);
  const [worldState, setWorldState] = useState<WorldState | null>(null);
  const [selectedNode, setSelectedNode] = useState<JourneyGraphNode | null>(null);
  const [graphMode, setGraphMode] = useState<'clinic' | 'case'>(initialUrlState.mode);
  const [clinicView, setClinicView] = useState<'graph' | 'simulation'>('graph');
  const [clinicVersion, setClinicVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refreshFacilities = (selectAfter?: string) => {
    listFacilities()
      .then(({ facilities }) => {
        setFacilities(facilities);
        if (selectAfter) setSelectedFacility(selectAfter);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(() => refreshFacilities(), []);

  const refreshRuns = () => {
    // Scoped to the currently selected Haus - a Rehazentrum's cases never
    // appear while looking at the Krankenhaus, and vice versa.
    listScenarioRuns(selectedFacility)
      .then(({ scenarioRunIds }) => {
        setScenarioRuns(scenarioRunIds);
        setSelectedRun((current) => (current && scenarioRunIds.includes(current) ? current : scenarioRunIds[0] ?? null));
        setClinicVersion((v) => v + 1);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(refreshRuns, [selectedFacility]);
  useEffect(() => writeUrlState(selectedFacility, selectedRun, graphMode), [selectedFacility, selectedRun, graphMode]);

  const refreshWorldState = () => {
    if (!selectedRun) { setWorldState(null); return; }
    setError(null);
    getWorldState(selectedRun)
      .then(setWorldState)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    setClinicVersion((v) => v + 1);
  };

  useEffect(() => { setSelectedNode(null); refreshWorldState(); }, [selectedRun]);

  const selectedEntity = selectedNode && selectedNode.kind !== 'openEHR'
    ? worldState?.entities.find((entity) => entity.scenarioKey === selectedNode.id)
    : undefined;
  const selectedCapability = selectedNode?.kind === 'openEHR'
    ? worldState?.capabilities.find((capability) => capability.capability === selectedNode.capability)
    : undefined;

  const isEmpty = worldState && worldState.entities.length === 0;

  const drillDownToCase = (scenarioRunId: string) => {
    setSelectedRun(scenarioRunId);
    setGraphMode('case');
    setSelectedNode(null);
  };

  const handleSelectNode = (node: JourneyGraphNode) => {
    if (graphMode === 'clinic') {
      if (node.scenarioRunId) drillDownToCase(node.scenarioRunId);
      return;
    }
    setSelectedNode(node);
  };

  return (
    <div style={{ maxWidth: '1280px', margin: '0 auto', padding: '1.75rem 1.5rem 3rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.5rem' }}>🏥 Clinical Scenario Workbench</h1>
          <p style={{ margin: '0.15rem 0 0', color: '#64748b', fontSize: '0.85rem' }}>Die Patientenreise durch die Klinik, Schritt für Schritt, mit echten FHIR- und openEHR-Daten.</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <select
            value={selectedRun ?? ''}
            onChange={(event) => setSelectedRun(event.target.value)}
            style={selectStyle}
          >
            {scenarioRuns.length === 0 && <option value="">Kein Fall vorhanden</option>}
            {scenarioRuns.map((runId) => <option key={runId} value={runId}>{runId}</option>)}
          </select>
        </div>
      </header>

      <div className="card" style={{ padding: '1rem 1.25rem', marginBottom: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <FacilitySelector
          facilities={facilities}
          selectedFacility={selectedFacility}
          onSelect={(facilityId) => { setSelectedFacility(facilityId); setSelectedRun(null); setGraphMode('clinic'); }}
          onOpened={(facilityId) => { refreshFacilities(facilityId); setSelectedRun(null); setGraphMode('clinic'); }}
        />
        <NewRunForm facilityId={selectedFacility} onCreated={(runId) => { refreshRuns(); setSelectedRun(runId); setGraphMode('case'); }} />
      </div>

      <ResourceFormManager />

      {error && <p style={{ color: '#b91c1c' }}>{error}</p>}

      <div className="card" style={{ padding: '1.1rem 1.25rem', marginBottom: '1.25rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.9rem', flexWrap: 'wrap', gap: '0.6rem' }}>
          <h2 style={{ margin: 0, fontSize: '1.05rem' }}>Patientenreise</h2>
          <GraphModeTabs
            mode={graphMode}
            onChange={setGraphMode}
            caseLabel={selectedRun ? `Fall: ${selectedRun}` : 'Fall'}
            caseDisabled={!selectedRun}
          />
        </div>

        {graphMode === 'case' && selectedRun && (
          <div style={{ marginBottom: '0.9rem' }}>
            <SimulationControls
              scenarioRunId={selectedRun}
              onAdvanced={refreshWorldState}
              onReset={() => { refreshRuns(); setSelectedRun(null); setGraphMode('clinic'); }}
            />
          </div>
        )}

        {graphMode === 'clinic' && (
          <>
            <div style={{ marginBottom: '0.9rem' }}>
              <div style={{ display: 'inline-flex', gap: '0.2rem', background: '#f1f5f9', borderRadius: '10px', padding: '0.2rem' }}>
                {(['graph', 'simulation'] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    onClick={() => setClinicView(view)}
                    style={{
                      border: 0, borderRadius: '8px', padding: '0.4rem 0.9rem', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
                      background: clinicView === view ? '#0f172a' : 'transparent', color: clinicView === view ? 'white' : '#475569',
                    }}
                  >
                    {view === 'graph' ? '🗺️ Graph' : '🎬 Simulation'}
                  </button>
                ))}
              </div>
            </div>
            {clinicView === 'graph' && (
              <JourneyGraph
                source={{ type: 'clinic', facilityId: selectedFacility }}
                refreshKey={clinicVersion}
                selectedNodeId={selectedNode?.id}
                onSelectNode={handleSelectNode}
                onDrillDown={drillDownToCase}
              />
            )}
            {clinicView === 'simulation' && <HospitalSimulation facilityId={selectedFacility} />}
          </>
        )}

        {graphMode === 'case' && !selectedRun && (
          <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Legen Sie oben einen neuen Fall an, um loszulegen.</p>
        )}

        {graphMode === 'case' && selectedRun && isEmpty && (
          <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Leerer Fall - drücken Sie Step, um das Szenario zu starten.</p>
        )}

        {graphMode === 'case' && selectedRun && !isEmpty && (
          <JourneyGraph
            source={{ type: 'case', scenarioRunId: selectedRun }}
            refreshKey={worldState}
            selectedNodeId={selectedNode?.id}
            onSelectNode={handleSelectNode}
          />
        )}

        {graphMode === 'case' && selectedEntity && (
          <div style={{ marginTop: '1rem' }}>
            <ResourceInspector scenarioRunId={selectedRun!} entity={selectedEntity} />
          </div>
        )}
        {graphMode === 'case' && selectedCapability && (
          <div style={{ marginTop: '1rem' }}>
            <OpenEhrEmbed scenarioRunId={selectedRun!} capability={selectedCapability} />
          </div>
        )}
      </div>

      {graphMode === 'case' && selectedRun && worldState && !isEmpty && (
        <div className="card" style={{ padding: '1rem 1.25rem', marginBottom: '1.25rem' }}>
          <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.05rem' }}>Timeline</h2>
          <Timeline scenarioRunId={selectedRun} refreshKey={worldState} />
        </div>
      )}

      {graphMode === 'case' && worldState && worldState.activityLog.length > 0 && (
        <details className="card" style={{ padding: '1rem 1.25rem' }}>
          <summary style={{ cursor: 'pointer', fontSize: '1.05rem', fontWeight: 600 }}>Activity-Log ({worldState.activityLog.length})</summary>
          <ul style={{ listStyle: 'none', padding: 0, marginBottom: 0, fontSize: '0.85rem' }}>
            {worldState.activityLog.slice().reverse().map((entry) => (
              <li key={entry.id} style={{ display: 'flex', gap: '0.5rem', padding: '0.35rem 0', borderBottom: '1px solid #f1f5f9' }}>
                <span aria-hidden="true">{entry.result === 'success' ? '✓' : '✕'}</span>
                <span style={{ color: entry.result === 'success' ? '#15803d' : '#b91c1c', flexShrink: 0 }}>{entry.action}</span>
                <span style={{ color: '#94a3b8' }}>{entry.message}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
