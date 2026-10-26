import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap, Position,
  useNodesState, useEdgesState, MarkerType,
  type Node, type Edge, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import { getClinicGraph, getJourneyGraph, type JourneyGraphEdge, type JourneyGraphNode, type MovementMoment } from '../api/client';

/**
 * The "journey through the hospital" visualization - built on React Flow
 * (@xyflow/react, MIT) for the interactive, genuinely draggable/pannable/
 * zoomable node-edge canvas, and dagre (@dagrejs/dagre, MIT - React Flow's
 * own commonly-recommended companion layout engine) for automatic
 * left-to-right layered layout of a case's own journey. Two data sources
 * (`source` prop):
 *
 * - `case`: one case's own full detail, laid out by dagre. Dragging a node
 *   is remembered across polling refetches via `positionsRef` - only a
 *   node id that has NEVER been positioned before gets dagre's fresh
 *   layout position, so manually rearranging the board is never silently
 *   undone.
 * - `clinic`: the bird's-eye "floor plan" view across every case at once.
 *   Location nodes (localLocations.ts's own local, non-FHIR wards) get
 *   fixed anchor positions; every Patient is positioned clustered near
 *   wherever their own real, timestamped transfer history
 *   (graph/build.ts's `movements`) says they currently are - "clustered
 *   near a fixed anchor and re-computed from real data" rather than
 *   user-draggable, since the whole point here is watching them move on
 *   their own as the time-scrubber advances through REAL history (never a
 *   fabricated future moment - the scrubber cannot go past the last real
 *   movement).
 */
const NODE_WIDTH = 232;
const NODE_HEIGHT = 108;

const PROVENANCE_COLORS: Record<string, string> = {
  SOURCE: '#2563eb', DERIVED: '#7c3aed', GENERATED: '#b45309', USER: '#15803d',
};

const RESOURCE_ACCENTS: Record<string, string> = {
  Patient: '#2563eb', Encounter: '#475569', HealthcareService: '#0d9488',
  Schedule: '#4f46e5', Slot: '#d97706', Appointment: '#e11d48', Practitioner: '#0891b2',
};
const OPENEHR_ACCENT = '#7c3aed';
const LOCATION_ACCENT = '#059669';

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  Patient: 'Patient', Encounter: 'Encounter', HealthcareService: 'Fachabteilung',
  Schedule: 'Schedule', Slot: 'Slot', Appointment: 'Termin', Practitioner: 'Mitarbeitende/r',
};

const RESOURCE_ICONS: Record<string, string> = {
  Patient: '🧑', Encounter: '🚑', HealthcareService: '🏬', Schedule: '🗓️', Slot: '⏱️', Appointment: '📅', Practitioner: '🩺',
};

type GraphNodeData = {
  node: JourneyGraphNode;
  onSelect: (node: JourneyGraphNode) => void;
  onDrillDown?: (scenarioRunId: string) => void;
  onOpenPatient?: (patientScenarioKey: string) => void;
  /** Klinik view only - Patients are the "last, least important link" (the
   * user's own correction after the first Klinik view came across too
   * patient-centric): a small, quiet pill instead of a full data card, so
   * the Station/Mitarbeitende hierarchy above them stays visually primary. */
  compact?: boolean;
};

function accentFor(node: JourneyGraphNode): string {
  if (node.kind === 'patient') return RESOURCE_ACCENTS.Patient;
  if (node.kind === 'openEHR') return OPENEHR_ACCENT;
  if (node.kind === 'location') return LOCATION_ACCENT;
  return RESOURCE_ACCENTS[node.resourceType ?? ''] ?? '#475569';
}

function FlowNodeCard({ data, selected }: NodeProps<Node<GraphNodeData>>) {
  const { node, onDrillDown, onOpenPatient, compact } = data;
  const isPatient = node.kind === 'patient';
  const isOpenEhr = node.kind === 'openEHR';
  const isLocation = node.kind === 'location';
  const accent = accentFor(node);
  const icon = isOpenEhr ? '📄' : isLocation ? '🏥' : RESOURCE_ICONS[node.resourceType ?? ''] ?? '⚬';

  // Klinik view's Patient cards - deliberately the smallest, quietest thing
  // on the board (the user's own correction: "letztes Glied, nicht so
  // wichtig"). Still clickable (onClick is wired at the ReactFlow level),
  // just no big card, no detail rows, no buttons.
  if (compact) {
    return (
      <div
        style={{
          animation: 'csw-node-appear 0.4s ease-out',
          display: 'flex', alignItems: 'center', gap: '0.3rem',
          width: 118, padding: '0.3rem 0.55rem',
          borderRadius: '999px',
          background: selected ? '#dbeafe' : '#f1f5f9',
          border: selected ? `1.5px solid ${accent}` : '1px solid #e2e8f0',
          cursor: 'pointer',
          transition: 'background 0.18s ease, transform 0.3s ease',
        }}
      >
        <span aria-hidden="true" style={{ fontSize: '0.72rem' }}>🧑</span>
        <span style={{ fontSize: '0.68rem', fontWeight: 600, color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.label}
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        animation: 'csw-node-appear 0.4s ease-out, csw-pulse-ring 1.1s ease-out 0.15s',
        width: isLocation ? 280 : NODE_WIDTH,
        minHeight: isLocation ? 96 : 72,
        display: 'flex',
        borderRadius: '14px',
        background: isLocation ? `linear-gradient(135deg, ${accent}, #047857)` : 'white',
        color: isLocation ? 'white' : '#0f172a',
        boxShadow: isLocation
          ? '0 10px 30px rgba(4,120,87,0.28)'
          : selected
            ? `0 0 0 3px ${accent}55, 0 10px 28px rgba(15,23,42,0.16)`
            : '0 2px 10px rgba(15,23,42,0.07)',
        border: isLocation ? (selected ? '2px solid white' : 'none') : node.shared ? `1.5px dashed ${accent}88` : '1px solid #eef1f5',
        overflow: 'hidden',
        cursor: 'pointer',
        transition: 'box-shadow 0.18s ease, transform 0.12s ease',
      }}
    >
      {!isLocation && <div style={{ width: '5px', flexShrink: 0, background: accent }} />}
      <div style={{ padding: isLocation ? '0.8rem 1rem' : '0.55rem 0.7rem', flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <span aria-hidden="true" style={{ fontSize: isLocation ? '1.3rem' : '0.85rem' }}>{icon}</span>
          <span style={{ fontSize: isLocation ? '0.7rem' : '0.64rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: isLocation ? 'rgba(255,255,255,0.85)' : accent }}>
            {isLocation ? 'Station' : isOpenEhr ? 'openEHR' : isPatient ? 'Patient' : (RESOURCE_TYPE_LABELS[node.resourceType ?? ''] ?? node.resourceType)}
          </span>
          {node.shared && !isLocation && <span style={{ marginLeft: 'auto', fontSize: '0.58rem', fontWeight: 600, color: '#94a3b8', background: '#f1f5f9', borderRadius: '999px', padding: '0.05rem 0.4rem' }}>Klinik</span>}
        </div>
        <div style={{ fontWeight: 700, fontSize: isLocation ? '1.15rem' : '0.9rem', marginTop: '0.25rem', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
          {node.label}
        </div>
        {node.details.length > 0 && (
          <div style={{ marginTop: isLocation ? '0.35rem' : '0.2rem' }}>
            {node.details.slice(0, 3).map((line, i) => (
              <div key={i} style={{ fontSize: isLocation ? '0.78rem' : '0.7rem', fontWeight: isLocation ? 600 : 400, color: isLocation ? 'rgba(255,255,255,0.92)' : '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{line}</div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.35rem' }}>
          {node.provenance && (
            <span style={{
              fontSize: '0.58rem', fontWeight: 700, padding: '0.02rem 0.4rem', borderRadius: '999px',
              color: isLocation ? 'white' : PROVENANCE_COLORS[node.provenance] ?? '#64748b',
              border: `1px solid ${isLocation ? 'rgba(255,255,255,0.6)' : PROVENANCE_COLORS[node.provenance] ?? '#cbd5e1'}66`,
            }}>
              {node.provenance}
            </span>
          )}
          {node.scenarioRunId && onDrillDown && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDrillDown(node.scenarioRunId!); }}
              style={{ marginLeft: 'auto', fontSize: '0.62rem', fontWeight: 600, border: 0, background: 'transparent', color: accent, cursor: 'pointer', padding: 0 }}
            >
              Fall öffnen →
            </button>
          )}
          {!isPatient && node.patientScenarioKey && onOpenPatient && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpenPatient(node.patientScenarioKey!); }}
              style={{ marginLeft: 'auto', fontSize: '0.62rem', fontWeight: 600, border: 0, background: 'transparent', color: accent, cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: '0.2rem' }}
            >
              🧑 Patient öffnen
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const nodeTypes = { card: FlowNodeCard };

function dagreLayout(nodes: JourneyGraphNode[], edges: { from: string; to: string }[]): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 110 });
  nodes.forEach((node) => g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach((edge) => { if (g.hasNode(edge.from) && g.hasNode(edge.to)) g.setEdge(edge.from, edge.to); });
  dagre.layout(g);
  const result = new Map<string, { x: number; y: number }>();
  nodes.forEach((node) => {
    const pos = g.node(node.id);
    result.set(node.id, { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 });
  });
  return result;
}

/** The Klinik view's own "floor plan" - restructured per the user's own
 * correction that the first version was too patient-centric. Hierarchy,
 * top to bottom, most to least visually important:
 *   1. Station (Location) - big, data-rich, fixed anchor per station.
 *   2. Mitarbeitende (real Practitioner FHIR entities) - hang directly off
 *      their own station via the real `staff-edge:` edges.
 *   3. Patienten - the last, smallest, quietest link, clustered under
 *      whichever station their own real transfer history (`movements`)
 *      puts them at, at or before `cutoff` (undefined = live). A patient
 *      with no qualifying movement yet sits in a "not yet arrived" holding
 *      area, never at a guessed position.
 * Organizational scheduling capacity (HealthcareService/Schedule) isn't
 * part of the physical floor plan at all - pushed to its own row at the
 * very bottom, least prominent. */
function floorPlanLayout(nodes: JourneyGraphNode[], edges: JourneyGraphEdge[], movements: MovementMoment[], cutoff: string | undefined): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const locations = nodes.filter((n) => n.kind === 'location').slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const practitioners = nodes.filter((n) => n.resourceType === 'Practitioner');
  const hubs = nodes.filter((n) => n.kind === 'fhir' && n.resourceType !== 'Practitioner');
  const patients = nodes.filter((n) => n.kind === 'patient');

  locations.forEach((n, i) => positions.set(n.id, { x: 60 + i * 420, y: 30 }));

  const staffCluster = new Map<string, number>();
  let unstaffed = 0;
  practitioners.forEach((practitioner) => {
    const staffEdge = edges.find((e) => e.id.startsWith('staff-edge:') && e.to === practitioner.id);
    const anchor = staffEdge ? positions.get(staffEdge.from) : undefined;
    if (!anchor) {
      positions.set(practitioner.id, { x: -280, y: 30 + unstaffed * 90 });
      unstaffed += 1;
      return;
    }
    const idx = staffCluster.get(staffEdge!.from) ?? 0;
    staffCluster.set(staffEdge!.from, idx + 1);
    positions.set(practitioner.id, { x: anchor.x + idx * 150 - 24, y: anchor.y + 190 });
  });

  const patientCluster = new Map<string, number>();
  let unassigned = 0;
  patients.forEach((patient) => {
    const own = movements.filter((m) => m.patientNodeId === patient.id && (!cutoff || m.timestamp <= cutoff));
    const latest = own[own.length - 1];
    if (!latest) {
      positions.set(patient.id, { x: -280, y: 320 + unassigned * 60 });
      unassigned += 1;
      return;
    }
    const anchor = positions.get(latest.locationScenarioKey) ?? { x: 60, y: 30 };
    const idx = patientCluster.get(latest.locationScenarioKey) ?? 0;
    patientCluster.set(latest.locationScenarioKey, idx + 1);
    positions.set(patient.id, { x: anchor.x + (idx % 5) * 62 - 155, y: anchor.y + 350 + Math.floor(idx / 5) * 55 });
  });

  hubs.forEach((n, i) => positions.set(n.id, { x: 60 + i * 300, y: 620 }));

  return positions;
}

/** Re-derives every "aktuell" (current-location) edge from `movements` +
 * `cutoff` rather than trusting whatever the server last returned - so the
 * time-scrubber and the live view use exactly the same logic, and a
 * patient with no qualifying movement yet at `cutoff` simply has no
 * location edge (never a fabricated one). */
function locationEdgesAsOf(patients: JourneyGraphNode[], movements: MovementMoment[], cutoff: string | undefined): { id: string; from: string; to: string; label: string }[] {
  const edges: { id: string; from: string; to: string; label: string }[] = [];
  for (const patient of patients) {
    const own = movements.filter((m) => m.patientNodeId === patient.id && (!cutoff || m.timestamp <= cutoff));
    const latest = own[own.length - 1];
    if (latest) edges.push({ id: `location-edge:${patient.id}`, from: patient.id, to: latest.locationScenarioKey, label: 'aktuell' });
  }
  return edges;
}

export type GraphSource = { type: 'case'; scenarioRunId: string } | { type: 'clinic'; facilityId: string };

const CASE_LEGEND: Array<{ label: string; color: string }> = [
  { label: 'Patient', color: RESOURCE_ACCENTS.Patient },
  { label: 'Encounter', color: RESOURCE_ACCENTS.Encounter },
  { label: 'Fachabteilung', color: RESOURCE_ACCENTS.HealthcareService },
  { label: 'Schedule', color: RESOURCE_ACCENTS.Schedule },
  { label: 'Slot', color: RESOURCE_ACCENTS.Slot },
  { label: 'Termin', color: RESOURCE_ACCENTS.Appointment },
  { label: 'Mitarbeitende/r', color: RESOURCE_ACCENTS.Practitioner },
  { label: 'openEHR', color: OPENEHR_ACCENT },
];

const CLINIC_LEGEND: Array<{ label: string; color: string }> = [
  { label: 'Station (lokal)', color: LOCATION_ACCENT },
  { label: 'Mitarbeitende/r (real)', color: RESOURCE_ACCENTS.Practitioner },
  { label: 'Fachabteilung / Schedule', color: RESOURCE_ACCENTS.HealthcareService },
  { label: 'Patient', color: RESOURCE_ACCENTS.Patient },
];

function formatMoment(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** The honest time-scrubber: every step is a REAL, already-happened
 * transfer (graph/build.ts's `movements`) - it can only ever move between
 * real moments, never interpolate or fast-forward into a future the
 * simulation hasn't reached. `index === null` means "live" (always the
 * latest real state, tracking new movements as they happen); a numeric
 * index freezes the view as of that one real moment. */
function TimeScrubber({ movements, nodeById, index, onChange }: {
  movements: MovementMoment[];
  nodeById: Map<string, JourneyGraphNode>;
  index: number | null;
  onChange: (index: number | null) => void;
}) {
  if (movements.length === 0) return null;
  const effectiveIndex = index ?? movements.length - 1;
  const moment = movements[effectiveIndex];
  const patientLabel = nodeById.get(moment.patientNodeId)?.label ?? moment.patientNodeId;
  const locationLabel = nodeById.get(moment.locationScenarioKey)?.label ?? moment.locationScenarioKey;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem', padding: '0.6rem 0.9rem', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px' }}>
      <span style={{ fontSize: '1.1rem' }} aria-hidden="true">🕘</span>
      <input
        type="range"
        min={0}
        max={movements.length - 1}
        value={effectiveIndex}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, accentColor: LOCATION_ACCENT }}
      />
      <div style={{ fontSize: '0.78rem', color: '#475569', minWidth: '15rem', flexShrink: 0 }}>
        <span style={{ fontFamily: 'monospace', color: '#94a3b8' }}>{formatMoment(moment.timestamp)}</span>
        {' · '}
        <strong>{patientLabel}</strong> → {locationLabel}
      </div>
      <button
        type="button"
        onClick={() => onChange(null)}
        disabled={index === null}
        style={{
          fontSize: '0.75rem', fontWeight: 700, padding: '0.25rem 0.7rem', borderRadius: '999px', border: 'none', cursor: index === null ? 'default' : 'pointer',
          background: index === null ? LOCATION_ACCENT : '#e2e8f0', color: index === null ? 'white' : '#475569',
        }}
      >
        ● Live
      </button>
    </div>
  );
}

export function JourneyGraph({ source, refreshKey, onSelectNode, onDrillDown, selectedNodeId }: {
  source: GraphSource;
  refreshKey?: unknown;
  onSelectNode: (node: JourneyGraphNode) => void;
  onDrillDown?: (scenarioRunId: string) => void;
  selectedNodeId?: string | null;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<GraphNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [rawNodes, setRawNodes] = useState<JourneyGraphNode[]>([]);
  const [rawEdges, setRawEdges] = useState<JourneyGraphEdge[]>([]);
  const [movements, setMovements] = useState<MovementMoment[]>([]);
  const [timeIndex, setTimeIndex] = useState<number | null>(null);
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const sourceKeyRef = useRef<string | null>(null);

  const sourceKey = source.type === 'case' ? `case:${source.scenarioRunId}` : `clinic:${source.facilityId}`;
  const isClinic = source.type === 'clinic';

  useEffect(() => {
    let cancelled = false;
    const fetchGraph = source.type === 'case' ? getJourneyGraph(source.scenarioRunId) : getClinicGraph(source.facilityId);
    fetchGraph.then((graph) => {
      if (cancelled) return;
      if (sourceKeyRef.current !== sourceKey) {
        positionsRef.current = new Map();
        sourceKeyRef.current = sourceKey;
        setTimeIndex(null);
      }
      setRawNodes(graph.nodes);
      setRawEdges(graph.edges ?? []);
      setMovements(graph.movements ?? []);

      const nonLocationEdges = (graph.edges ?? []).filter((e) => !e.id.startsWith('location-edge:'));
      const flowEdges: Edge[] = nonLocationEdges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        label: edge.label,
        animated: true,
        type: 'smoothstep',
        style: { stroke: '#94a3b8', strokeWidth: 1.5 },
        labelStyle: { fontSize: 10, fill: '#64748b', fontWeight: 600 },
        labelBgStyle: { fill: '#f8fafc' },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8', width: 16, height: 16 },
      }));
      setEdges(flowEdges);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }).catch(() => { /* surfaced by the parent already loading worldState/runs */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, refreshKey]);

  const nodeById = useMemo(() => new Map(rawNodes.map((n) => [n.id, n])), [rawNodes]);

  // Rebuilds the rendered node set (position + location edges) whenever the
  // raw fetch changes OR the time-scrubber moves - kept separate from the
  // fetch effect above so scrubbing never re-hits the network.
  useEffect(() => {
    if (rawNodes.length === 0) { setNodes([]); return; }
    const cutoff = isClinic && timeIndex !== null ? movements[timeIndex]?.timestamp : undefined;
    const layout = isClinic ? floorPlanLayout(rawNodes, rawEdges, movements, cutoff) : dagreLayout(rawNodes, rawEdges);

    const onOpenPatient = (patientScenarioKey: string) => {
      const patientNode = nodeById.get(patientScenarioKey);
      if (patientNode) onSelectNode(patientNode);
    };

    const flowNodes: Node<GraphNodeData>[] = rawNodes.map((node) => {
      let position = layout.get(node.id) ?? { x: 0, y: 0 };
      if (!isClinic) {
        // Case view keeps the drag-persistence behavior; the Klinik floor
        // plan is always freshly computed (that's the point - it's a live
        // map, not a freeform diagram).
        position = positionsRef.current.get(node.id) ?? position;
        positionsRef.current.set(node.id, position);
      }
      return {
        id: node.id,
        type: 'card',
        position,
        data: { node, onSelect: onSelectNode, onDrillDown, onOpenPatient, compact: isClinic && node.kind === 'patient' },
        selected: node.id === selectedNodeId,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      };
    });
    setNodes(flowNodes);

    if (isClinic) {
      const patients = rawNodes.filter((n) => n.kind === 'patient');
      const locationEdges: Edge[] = locationEdgesAsOf(patients, movements, cutoff).map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        label: edge.label,
        animated: true,
        type: 'smoothstep',
        style: { stroke: LOCATION_ACCENT, strokeWidth: 2.5 },
        labelStyle: { fontSize: 10, fill: LOCATION_ACCENT, fontWeight: 700 },
        labelBgStyle: { fill: '#f8fafc' },
        markerEnd: { type: MarkerType.ArrowClosed, color: LOCATION_ACCENT, width: 16, height: 16 },
      }));
      setEdges((current) => [...current.filter((e) => !e.id.startsWith('location-edge:')), ...locationEdges]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawNodes, rawEdges, movements, timeIndex, isClinic, selectedNodeId]);

  const onNodeClick = (_event: unknown, node: Node<GraphNodeData>) => {
    onSelectNode(node.data.node);
  };

  const onNodeDragStop = (_event: unknown, node: Node<GraphNodeData>) => {
    if (!isClinic) positionsRef.current.set(node.id, node.position);
  };

  const legend = useMemo(() => (isClinic ? CLINIC_LEGEND : CASE_LEGEND), [isClinic]);

  if (rawNodes.length === 0) {
    return (
      <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>
        {source.type === 'clinic' ? 'Noch keine Fälle - starten Sie einen Scenario Run.' : 'Noch keine Daten - drücken Sie Step, um die Reise zu beginnen.'}
      </p>
    );
  }

  return (
    <div>
      {isClinic && <TimeScrubber movements={movements} nodeById={nodeById} index={timeIndex} onChange={setTimeIndex} />}
      <div style={{ height: '600px', borderRadius: '14px', overflow: 'hidden', border: '1px solid #e2e8f0', background: 'linear-gradient(180deg, #fafbfc, #f1f5f9)' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onNodeDragStop={onNodeDragStop}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
          nodesDraggable
          elementsSelectable
          panOnDrag
          zoomOnScroll
          minZoom={0.15}
          maxZoom={1.5}
          defaultEdgeOptions={{ type: 'smoothstep' }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#dbe2ea" />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => {
              const data = (n as Node<GraphNodeData>).data?.node;
              return data ? accentFor(data) : '#cbd5e1';
            }}
            maskColor="rgba(241,245,249,0.6)"
            style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px' }}
          />
        </ReactFlow>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.9rem', marginTop: '0.6rem', fontSize: '0.72rem', color: '#64748b' }}>
        {legend.map((item) => (
          <span key={item.label} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
            <span style={{ width: '0.55rem', height: '0.55rem', borderRadius: '3px', background: item.color, display: 'inline-block' }} />
            {item.label}
          </span>
        ))}
        <span style={{ marginLeft: 'auto', color: '#94a3b8' }}>
          {isClinic ? 'Station → Mitarbeitende → Patient · Stationen sind fix, Patienten bewegen sich mit echten Zeitstempeln' : 'gestrichelt = geteilte Klinik-Ressource · Knoten sind frei verschiebbar'}
        </span>
      </div>
    </div>
  );
}

export default JourneyGraph;
