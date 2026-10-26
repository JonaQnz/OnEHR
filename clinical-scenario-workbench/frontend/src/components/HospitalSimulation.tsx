import { useEffect, useRef, useState } from 'react';
import {
  getHospitalState, getTimeline, getWorldState, listScenarioRuns, stepScenario,
  type EntityActivityStatus, type LocalLocation, type ScenarioEvent,
} from '../api/client';

/**
 * User's own ask: actually WATCH the clinic work - a patient arrives, talks
 * to reception, gets a bed, a doctor comes by whenever he has time (bed to
 * bed), nurses more often on their own schedule, with visible thoughts/
 * actions, on a real ticking clock instead of manual Step clicks. Explicit
 * scope from the user: no big room/floor-plan structuring, simple stations,
 * literal direct point-to-point movement, not overkill.
 *
 * Deliberately reuses EVERY piece of state as-is (activity/entityStatus.ts,
 * world/locationLog.ts, scenario/engine.ts's already-existing execution
 * pipeline via stepScenario) - this component adds zero new backend
 * concepts, just a real-time-paced client-side driver + a plain absolute-
 * position/CSS-transition canvas. No React Flow/dagre (JourneyGraph's own
 * library) - deliberately simpler than that.
 */

const RECEPTION = { x: 40, y: 20 };
const STATION_W = 200;
const STATION_H = 140;
const GAP_X = 20;
const GAP_Y = 90;
const COLS = 4;
const STATION_TOP = 110;
const MAX_VISIBLE_BEDS = 4;
const ARRIVAL_PAUSE_MS = 1500;
const PULSE_MS = 2600;
const TICK_MS = 300;

function stationPos(index: number): { x: number; y: number } {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  return { x: 40 + col * (STATION_W + GAP_X), y: STATION_TOP + row * (STATION_H + GAP_Y) };
}

function bedSlotPos(stationIndex: number, slot: number): { x: number; y: number } {
  const { x, y } = stationPos(stationIndex);
  return { x: x + 16 + (slot % 2) * 90, y: y + 40 + Math.floor(slot / 2) * 54 };
}

function staffPos(stationIndex: number): { x: number; y: number } {
  const { x, y } = stationPos(stationIndex);
  return { x: x + 16, y: y + STATION_H + 12 };
}

/** Tiny, deliberately duplicated copy of backend scenario/protocol.ts's own
 * `parseAt` - just 4 lines, specific to the scenario YAML's own "5m"/"3h"
 * convention, not worth a shared module or API field for. */
function parseAtMinutes(at: string): number {
  const match = /^(\d+)(h|m)$/.exec(at.trim());
  if (!match) return 0;
  const amount = Number(match[1]);
  return match[2] === 'h' ? amount * 60 : amount;
}

function formatSimClock(totalMinutes: number): string {
  const day = Math.floor(totalMinutes / 1440) + 1;
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = Math.floor(totalMinutes % 60);
  return `Tag ${day}, ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

const STATUS_LABEL: Record<EntityActivityStatus, string> = {
  idle: '🛌 ruht',
  thinking: '🧠 denkt nach',
  'filling-form': '📋 wird dokumentiert',
  'blocked-needs-form': '⛔ wartet',
  moving: '🚶 unterwegs',
  talking: '💬 im Gespräch',
};

const EVENT_LABEL: Record<string, string> = {
  'patient-arrival': '🚪 Aufnahme',
  'ward-transfer': '🚑 Verlegung',
  'doctor-round': '🩺 Arztvisite',
  'nursing-round': '🧑‍⚕️ Pflegerunde',
  'vital-signs': '🌡️ Vitalzeichen',
  'patient-conversation': '💬 Gespräch',
  'medication-administration': '💊 Medikamentengabe',
  'medication-order': '📝 Anordnung',
  'order-basis': '📝 Anordnung',
  'lab-value': '🧪 Laborwert',
  'lab-result': '🧪 Laborbefund',
  procedure: '🔧 Eingriff',
  'diagnostic-report': '🩻 Befund',
  'coded-diagnosis': '🏷️ Diagnose',
  anamnesis: '📝 Anamnese',
  'discharge-letter': '🚪 Entlassbrief',
  'discharge-medication': '💊 Entlassmedikation',
  'request-imaging': '📅 Termin gebucht',
};

const DISCHARGE_TYPES = new Set(['discharge-letter', 'discharge-medication']);
const SPEEDS = [0.25, 1, 4, 20];

interface RunState {
  scenarioRunId: string;
  patientLabel: string;
  patientScenarioKey: string | null;
  stationKey: string | null;
  status: EntityActivityStatus;
  statusReason?: string;
  simClockMinutes: number;
  nextEventAtMinutes: number | null;
  nextFireAt: number | null;
  finished: boolean;
  discharged: boolean;
  atReception: boolean;
  lastLabel?: string;
}

interface Pulse {
  id: string;
  stationKey: string;
  label: string;
  expiresAt: number;
}

function labelForPatientKey(scenarioKey: string | null): string {
  if (!scenarioKey) return '?';
  const name = scenarioKey.replace(/^patient-/, '');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

async function loadRun(scenarioRunId: string): Promise<RunState> {
  const [{ timeline }, hospitalState, worldState] = await Promise.all([
    getTimeline(scenarioRunId),
    getHospitalState(scenarioRunId),
    getWorldState(scenarioRunId),
  ]);
  const patientEntity = worldState.entities.find((entity) => entity.resourceType === 'Patient');
  const patientScenarioKey = patientEntity?.scenarioKey ?? null;
  const status = hospitalState.entityStatus.find((s) => s.scenarioKey === patientScenarioKey);
  const last = hospitalState.locationHistory[hospitalState.locationHistory.length - 1];
  const nextEntry = timeline.find((t) => !t.completed);
  const finished = timeline.length > 0 && timeline.every((t) => t.completed);
  const discharged = timeline.some((t) => t.completed && DISCHARGE_TYPES.has(t.event.type));
  const simClockMinutes = timeline.filter((t) => t.completed).reduce((max, t) => Math.max(max, parseAtMinutes(t.event.at)), 0);
  const nextEventAtMinutes = nextEntry ? parseAtMinutes(nextEntry.event.at) : null;
  return {
    scenarioRunId,
    patientLabel: labelForPatientKey(patientScenarioKey),
    patientScenarioKey,
    stationKey: discharged ? null : last?.locationScenarioKey ?? null,
    status: status?.status ?? 'idle',
    statusReason: status?.reason,
    simClockMinutes,
    nextEventAtMinutes,
    // Paced at the default 1x here (this helper has no access to the
    // component's live speed setting) - purely a starting estimate for a
    // freshly-opened view; every subsequent event is correctly repaced by
    // `advance` itself using the live speed. A brand-new run's very first
    // event (always at:0h, delta 0) fires immediately either way.
    nextFireAt: nextEventAtMinutes !== null ? Date.now() + Math.max(0, nextEventAtMinutes - simClockMinutes) * 1000 : null,
    finished,
    discharged,
    atReception: !last && !discharged,
  };
}

export function HospitalSimulation({ facilityId }: { facilityId: string }) {
  const [stations, setStations] = useState<LocalLocation[]>([]);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const speedRef = useRef(speed);
  const pausedRef = useRef(paused);
  const busyRef = useRef<Set<string>>(new Set());
  const runsRef = useRef<Record<string, RunState>>({});
  speedRef.current = speed;
  pausedRef.current = paused;
  runsRef.current = runs;

  useEffect(() => {
    let cancelled = false;
    setStations([]);
    setRuns({});
    setPulses([]);
    listScenarioRuns(facilityId)
      .then(async ({ scenarioRunIds }) => {
        const loaded = await Promise.all(scenarioRunIds.map((id) => loadRun(id).catch(() => null)));
        if (cancelled) return;
        const nextRuns: Record<string, RunState> = {};
        for (const run of loaded) if (run) nextRuns[run.scenarioRunId] = run;
        setRuns(nextRuns);
        for (const id of scenarioRunIds) {
          const hs = await getHospitalState(id).catch(() => null);
          if (hs?.stations.length) { if (!cancelled) setStations(hs.stations); break; }
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    return () => { cancelled = true; };
  }, [facilityId]);

  useEffect(() => {
    setPulses((prev) => prev.filter((p) => p.expiresAt > Date.now()));
    const interval = setInterval(() => {
      setPulses((prev) => prev.filter((p) => p.expiresAt > Date.now()));
      if (pausedRef.current) return;
      const now = Date.now();
      // Reads from the ref (kept in sync with `runs` below), not the
      // `runs` state directly - calling an async side effect from inside a
      // setState updater is unsafe (React may invoke an updater more than
      // once, e.g. under StrictMode), so this stays a plain effect body.
      for (const run of Object.values(runsRef.current)) {
        if (run.finished || busyRef.current.has(run.scenarioRunId)) continue;
        if (run.nextFireAt === null || run.nextFireAt > now) continue;
        busyRef.current.add(run.scenarioRunId);
        advance(run);
      }
    }, TICK_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facilityId]);

  async function advance(run: RunState): Promise<void> {
    try {
      const result = await stepScenario(run.scenarioRunId);
      const [hospitalState, { timeline }] = await Promise.all([
        getHospitalState(run.scenarioRunId),
        getTimeline(run.scenarioRunId),
      ]);
      const status = hospitalState.entityStatus.find((s) => s.scenarioKey === run.patientScenarioKey);
      const last = hospitalState.locationHistory[hospitalState.locationHistory.length - 1];
      const nextEntry = timeline.find((t) => !t.completed);
      const dischargedNow = run.discharged || Boolean(result.event && DISCHARGE_TYPES.has(result.event.type));
      const isArrival = result.event?.type === 'patient-arrival';
      const newSimClock = result.event ? parseAtMinutes(result.event.at) : run.simClockMinutes;
      const label = result.event ? EVENT_LABEL[result.event.type] : undefined;
      if (label && last && !dischargedNow) {
        setPulses((prev) => [...prev, { id: `${run.scenarioRunId}-${Date.now()}`, stationKey: last.locationScenarioKey, label, expiresAt: Date.now() + PULSE_MS }]);
      }
      setRuns((prev) => ({
        ...prev,
        [run.scenarioRunId]: {
          ...run,
          stationKey: dischargedNow ? null : isArrival ? null : last?.locationScenarioKey ?? run.stationKey,
          atReception: dischargedNow || isArrival,
          status: status?.status ?? 'idle',
          statusReason: status?.reason,
          simClockMinutes: newSimClock,
          nextEventAtMinutes: nextEntry ? parseAtMinutes(nextEntry.event.at) : null,
          nextFireAt: nextEntry
            ? Date.now() + Math.max(0, (parseAtMinutes(nextEntry.event.at) - newSimClock)) * (1000 / speedRef.current)
            : null,
          finished: result.finished,
          discharged: dischargedNow,
          lastLabel: label ?? run.lastLabel,
        },
      }));
      if (isArrival && last) {
        setTimeout(() => {
          setRuns((prev) => {
            const current = prev[run.scenarioRunId];
            if (!current) return prev;
            return { ...prev, [run.scenarioRunId]: { ...current, stationKey: last.locationScenarioKey, atReception: false } };
          });
        }, ARRIVAL_PAUSE_MS);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current.delete(run.scenarioRunId);
    }
  }

  const stationIndex = new Map(stations.map((s, i) => [s.scenarioKey, i]));
  const runList = Object.values(runs);
  const presentByStation = new Map<string, RunState[]>();
  const receptionRuns: RunState[] = [];
  for (const run of runList) {
    if (run.atReception || run.discharged || !run.stationKey) { receptionRuns.push(run); continue; }
    const list = presentByStation.get(run.stationKey) ?? [];
    list.push(run);
    presentByStation.set(run.stationKey, list);
  }
  for (const list of presentByStation.values()) list.sort((a, b) => a.scenarioRunId.localeCompare(b.scenarioRunId));

  const rows = Math.max(1, Math.ceil(stations.length / COLS));
  const canvasWidth = 40 + Math.min(stations.length, COLS) * (STATION_W + GAP_X);
  const canvasHeight = STATION_TOP + rows * (STATION_H + GAP_Y);
  const simNow = runList.reduce((max, r) => Math.max(max, r.simClockMinutes), 0);
  const skipNow = () => setRuns((prev) => {
    const next = { ...prev };
    for (const key of Object.keys(next)) if (next[key].nextFireAt !== null) next[key] = { ...next[key], nextFireAt: Date.now() };
    return next;
  });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.9rem', flexWrap: 'wrap' }}>
        <button type="button" className="btn" onClick={() => setPaused((p) => !p)}>{paused ? '▶ Weiter' : '⏸ Pause'}</button>
        <div style={{ display: 'inline-flex', gap: '0.2rem', background: '#f1f5f9', borderRadius: '8px', padding: '0.2rem' }}>
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s)}
              style={{
                border: 0, borderRadius: '6px', padding: '0.3rem 0.6rem', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
                background: speed === s ? '#0f172a' : 'transparent', color: speed === s ? 'white' : '#475569',
              }}
            >
              {s}x
            </button>
          ))}
        </div>
        <button type="button" className="btn" onClick={skipNow}>⏩ jetzt</button>
        <span style={{ marginLeft: 'auto', fontFamily: 'monospace', fontSize: '0.85rem', color: '#334155', background: '#f1f5f9', padding: '0.35rem 0.7rem', borderRadius: '8px' }}>
          🕐 {formatSimClock(simNow)}
        </span>
      </div>
      {error && <p style={{ color: '#b91c1c', fontSize: '0.85rem' }}>{error}</p>}
      {stations.length === 0 && runList.length === 0 && (
        <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Keine aktiven Fälle in diesem Haus.</p>
      )}
      <div style={{ position: 'relative', width: canvasWidth, height: canvasHeight, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '12px', overflow: 'auto' }}>
        <div style={{ position: 'absolute', left: RECEPTION.x, top: RECEPTION.y, width: 100, textAlign: 'center' }}>
          <div style={{ fontSize: '1.4rem' }}>🛎️</div>
          <div style={{ fontSize: '0.68rem', color: '#64748b' }}>Empfang</div>
        </div>

        {stations.map((station, index) => {
          const { x, y } = stationPos(index);
          const present = presentByStation.get(station.scenarioKey) ?? [];
          const overflow = Math.max(0, present.length - MAX_VISIBLE_BEDS);
          const pulse = pulses.find((p) => p.stationKey === station.scenarioKey);
          return (
            <div key={station.scenarioKey}>
              <div style={{
                position: 'absolute', left: x, top: y, width: STATION_W, height: STATION_H,
                border: '1px solid #cbd5e1', borderRadius: '10px', background: 'white',
              }}>
                <div style={{ padding: '0.3rem 0.5rem', fontSize: '0.75rem', fontWeight: 700, color: '#334155', borderBottom: '1px solid #f1f5f9' }}>
                  {station.name}
                  {overflow > 0 && <span style={{ color: '#94a3b8', fontWeight: 500 }}> (+{overflow})</span>}
                </div>
              </div>
              {station.staffScenarioKeys.length > 0 && (
                <div style={{ position: 'absolute', left: staffPos(index).x, top: staffPos(index).y, fontSize: '1.2rem' }} title={station.staffScenarioKeys[0]}>
                  🧑‍⚕️
                  {pulse && (
                    <div style={{ position: 'absolute', top: '-1.6rem', left: '1.4rem', whiteSpace: 'nowrap', background: '#0f172a', color: 'white', fontSize: '0.68rem', padding: '0.15rem 0.5rem', borderRadius: '999px' }}>
                      {pulse.label}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {receptionRuns.map((run, i) => {
          const pos = { x: RECEPTION.x + (i % 3) * 34, y: RECEPTION.y + 44 + Math.floor(i / 3) * 34 };
          return <PatientDot key={run.scenarioRunId} run={run} pos={pos} faded={run.discharged} />;
        })}

        {stations.map((station, index) => {
          const present = (presentByStation.get(station.scenarioKey) ?? []).slice(0, MAX_VISIBLE_BEDS);
          return present.map((run, slot) => (
            <PatientDot key={run.scenarioRunId} run={run} pos={bedSlotPos(index, slot)} faded={false} />
          ));
        })}
      </div>
    </div>
  );
}

function PatientDot({ run, pos, faded }: { run: RunState; pos: { x: number; y: number }; faded: boolean }) {
  return (
    <div style={{
      position: 'absolute', left: pos.x, top: pos.y, width: 60, textAlign: 'center',
      transition: 'left 1.2s ease, top 1.2s ease, opacity 1.2s ease', opacity: faded ? 0.35 : 1,
    }}>
      <div style={{ fontSize: '1.3rem' }}>🧑‍🦽‍➡️</div>
      <div style={{ fontSize: '0.62rem', fontWeight: 700, color: '#334155' }}>{run.patientLabel}</div>
      <div style={{ fontSize: '0.6rem', color: '#64748b', whiteSpace: 'nowrap' }}>
        {faded ? '🏠 entlassen' : run.finished ? '🏁 fertig' : STATUS_LABEL[run.status]}
      </div>
    </div>
  );
}

export default HospitalSimulation;
