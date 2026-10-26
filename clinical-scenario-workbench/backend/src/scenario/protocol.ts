import type { Scenario, ScenarioEvent } from './types';

/**
 * User's own correction (in two stages): first, that a scenario listing a
 * handful of hand-authored events per station is "zu flach" - every
 * station KIND needs a real ruleset (admission/discharge/periodic
 * actions), applied automatically every load, not hand-authored. Second,
 * an explicit extension of that ruleset: nursing and doctor rounds N times
 * a day, BOTH able to trigger a bigger event, a light patient simulation
 * driving plausible vitals/labs, and sometimes an abnormal one that
 * matters. All of it real (three real, live-verified openEHR Form
 * Sections - Pflegebericht, Klinische Anordnung, Laborbericht mit Probe
 * (Panel) - see capability/catalog.ts's own doc comment), never invented
 * data shapes.
 *
 * `expandScenario` runs ONCE per `loadScenario` call and must be fully
 * DETERMINISTIC in which events it produces (ids, count, order) - every
 * Step/Play HTTP call reloads+re-expands the scenario file fresh, and
 * `executeNextEvent` finds "the next not-yet-completed event" by id against
 * that freshly-expanded list every time. If the severity simulation below
 * used real randomness (`Math.random()`), two consecutive expansions of the
 * IDENTICAL scenario file could produce a DIFFERENT event list (e.g. an
 * escalation appearing in one expansion but not the next), silently
 * corrupting progress tracking. Every pseudo-random decision here is
 * therefore seeded off a stable string (the candidate event's own id) via
 * `seededRandom` - the same event id always "rolls" the same number, so
 * the whole expansion is a pure function of the scenario file, even though
 * it still looks varied across different events/stations.
 */
export type StationKind = 'prehospital' | 'trauma-bay' | 'surgery' | 'intensive-care' | 'general-ward' | 'rehabilitation' | 'outpatient-clinic';

type ProtocolAction = 'vitals' | 'note' | 'nursing' | 'doctor' | 'lab';

interface StationProtocol {
  onAdmission: ProtocolAction[];
  onDischarge: ProtocolAction[];
  vitalsIntervalMinutes?: number;
  vitalsMaxOccurrences: number;
  /** "Die Pflege/der Arzt kommt n mal pro Tag" - a real daily cadence, not
   * a bare minute interval; converted to minutes internally. Fractional
   * values are fine (e.g. 0.3 - "roughly every 3 days" in Reha). */
  nursingRoundsPerDay?: number;
  doctorRoundsPerDay?: number;
  maxRoundsPerStay: number;
  /** If this station's own simulated severity gets bad enough during a
   * doctor round, the patient is really transferred here - reusing
   * whichever real station of this kind the scenario already visited
   * earlier (same real Location + real Practitioner), never an invented
   * one. Absent for the kinds already at the top of the escalation chain
   * in this model (intensive-care, surgery, prehospital, trauma-bay). */
  escalatesTo?: StationKind;
  /** User's own ask: every station declares an expandable list of the
   * capability NAMES (capability/catalog.ts's keys - openEHR today, FHIR
   * capabilities are named the same way via fhir/blueprint.ts's own
   * resourceType, nothing stops a future entry naming one) it may call on -
   * additive/descriptive only. Does NOT replace the fixed `ProtocolAction`
   * dispatch above (no behavior change for any already-passing scenario);
   * this is what a future generic, name-driven dispatch would read instead
   * of the switch, and what mcp/tools/capabilityTools.ts's tools search
   * against to answer "what could this station need but doesn't have a
   * Form for yet". */
  capabilities: string[];
}

/** One real, clinically-plausible ruleset per station kind - the actual
 * "was muss bei Aufnahme, was bei Entlassung, was alle x Minuten [und wie
 * oft kommen Pflege/Arzt vorbei]" the user asked for. */
const STATION_PROTOCOLS: Record<StationKind, StationProtocol> = {
  prehospital: { onAdmission: ['vitals'], onDischarge: [], vitalsMaxOccurrences: 0, maxRoundsPerStay: 0, capabilities: ['vital-signs'] },
  'trauma-bay': {
    onAdmission: ['vitals', 'note'], onDischarge: ['vitals'], vitalsIntervalMinutes: 30, vitalsMaxOccurrences: 4, maxRoundsPerStay: 0,
    capabilities: ['vital-signs', 'anamnesis', 'coded-diagnosis', 'procedure', 'order-basis'],
  },
  surgery: { onAdmission: ['note'], onDischarge: ['note'], vitalsMaxOccurrences: 0, maxRoundsPerStay: 0, capabilities: ['procedure', 'medication-administration'] },
  'intensive-care': {
    onAdmission: ['vitals', 'lab'], onDischarge: ['vitals'], vitalsIntervalMinutes: 240, vitalsMaxOccurrences: 6,
    nursingRoundsPerDay: 4, doctorRoundsPerDay: 2, maxRoundsPerStay: 6,
    capabilities: ['vital-signs', 'lab-result', 'lab-value', 'nursing-round', 'doctor-round', 'order-basis', 'medication-order', 'medication-administration', 'coded-diagnosis'],
  },
  'general-ward': {
    onAdmission: ['lab'], onDischarge: ['vitals'], vitalsIntervalMinutes: 720, vitalsMaxOccurrences: 4,
    nursingRoundsPerDay: 2, doctorRoundsPerDay: 1, maxRoundsPerStay: 5, escalatesTo: 'intensive-care',
    capabilities: [
      'vital-signs', 'lab-result', 'lab-value', 'nursing-round', 'doctor-round', 'order-basis', 'medication-order',
      'medication-administration', 'diagnostic-report', 'coded-diagnosis', 'discharge-letter', 'discharge-medication',
    ],
  },
  rehabilitation: {
    onAdmission: [], onDischarge: ['note'], vitalsMaxOccurrences: 0,
    nursingRoundsPerDay: 1, doctorRoundsPerDay: 0.3, maxRoundsPerStay: 4, escalatesTo: 'general-ward',
    capabilities: ['nursing-round', 'doctor-round', 'discharge-letter', 'discharge-medication'],
  },
  // A same-day ambulatory visit (user's own ask, live-motivated by the
  // pregnancy-ANC-visit case) - genuinely never admits or discharges in the
  // stationary sense (critic/rules.ts's own isAmbulatoryEncounter, keyed
  // off the arrival event's real HL7 classCode "AMB", suppresses the
  // discharge-time findings for exactly this reason), so `onAdmission`/
  // `onDischarge`/rounds are all empty rather than reusing a stationary
  // kind's cadence. `escalatesTo: 'general-ward'` covers the real case a
  // routine visit turns up something requiring admission after all.
  'outpatient-clinic': {
    onAdmission: [], onDischarge: [], vitalsMaxOccurrences: 0, maxRoundsPerStay: 0, escalatesTo: 'general-ward',
    capabilities: ['anamnesis', 'vital-signs', 'lab-value', 'order-basis', 'diagnostic-report', 'coded-diagnosis', 'pregnancy-status'],
  },
};

/** Every declared `StationKind` and its own capability list - backs
 * mcp/tools/capabilityTools.ts's `list_capabilities`/`resolve_capability`
 * ("what could THIS station need") without exposing `STATION_PROTOCOLS`
 * itself (its scheduling fields are an internal expansion detail, not part
 * of the capability-list contract). */
export function listStationCapabilities(): Record<StationKind, string[]> {
  return Object.fromEntries(
    (Object.entries(STATION_PROTOCOLS) as Array<[StationKind, StationProtocol]>).map(([kind, protocol]) => [kind, protocol.capabilities]),
  ) as Record<StationKind, string[]>;
}

/** Plausible-but-invented vital range per station kind (acuity-appropriate:
 * an ICU patient runs hotter/faster than someone in rehab) - the actual
 * NUMBERS within a kind's own range are then driven by the simulated
 * severity (worse severity -> a value further toward the sick end), not
 * uniformly random within it. */
const VITALS_RANGES: Record<StationKind, { hr: [number, number]; spo2: [number, number]; resp: [number, number]; temp: [number, number] }> = {
  prehospital: { hr: [90, 140], spo2: [88, 97], resp: [16, 30], temp: [35.5, 37.5] },
  'trauma-bay': { hr: [90, 140], spo2: [88, 97], resp: [16, 30], temp: [35.5, 38.0] },
  surgery: { hr: [65, 100], spo2: [94, 99], resp: [10, 16], temp: [35.5, 37.5] },
  'intensive-care': { hr: [70, 130], spo2: [88, 98], resp: [14, 28], temp: [36.2, 39.8] },
  'general-ward': { hr: [60, 95], spo2: [93, 99], resp: [12, 20], temp: [36.0, 38.2] },
  rehabilitation: { hr: [55, 85], spo2: [95, 99], resp: [12, 16], temp: [36.1, 37.2] },
  // A healthy ambulatory visitor, not a recovering inpatient - the
  // narrowest, most normal range of any kind here.
  'outpatient-clinic': { hr: [58, 88], spo2: [96, 99], resp: [12, 16], temp: [36.2, 37.2] },
};

/** Where each station kind's own light patient-state simulation starts -
 * "der Patient soll leicht simuliert werden": not a real physiological
 * model, just a single 0 (healthy) .. 1 (critical) number that nudges
 * toward this baseline on arrival and randomly (but deterministically -
 * see the file's own header comment) walks from there. */
const BASELINE_SEVERITY: Record<StationKind, number> = {
  prehospital: 0.55, 'trauma-bay': 0.75, surgery: 0.55, 'intensive-care': 0.65, 'general-ward': 0.3, rehabilitation: 0.15,
  'outpatient-clinic': 0.1,
};

/** A nursing round this severe also calls the doctor in - "beide können
 * Ereignisse auslösen" made concrete for the nursing side. */
const NURSE_CALLS_DOCTOR_THRESHOLD = 0.65;
/** A doctor round this severe writes an emergency order AND (if the
 * station has an `escalatesTo`) really transfers the patient there. */
const ESCALATION_THRESHOLD = 0.82;
/** A whole-scenario cap, independent of how many stations/rounds exist -
 * this is meant to add real texture, not turn into a runaway crisis loop. */
const MAX_ESCALATIONS = 2;

/** A small, deterministic string hash -> [0, 1) generator. Not
 * cryptographic, not meant to be - just stable per input string so the
 * same event id always "rolls" the same number (see the file's own header
 * comment for why that determinism is load-bearing, not cosmetic). */
function seededRandom(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  h = Math.imul(h ^ (h >>> 15), 1 | h);
  h ^= h + Math.imul(h ^ (h >>> 7), 61 | h);
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Nudges severity toward a station's own baseline on arrival (mostly the
 * new station's own acuity, some continuity from before), then applies one
 * small, deterministically-seeded step of drift - a gentle net
 * improvement on average, but noisy enough that an occasional step goes
 * the wrong way (a real, if invented, "complication"). */
function nudgeTowardBaseline(current: number, kind: StationKind): number {
  return clamp01(current * 0.4 + BASELINE_SEVERITY[kind] * 0.6);
}
/** Bimodal, not a plain uniform walk: most steps are a gentle, mostly-
 * recovering drift, but roughly 1 in 6 is also a real "complication" spike
 * on top - closer to how an actual clinical course behaves (mostly stable,
 * occasionally something real happens) than uniform noise, and tunable via
 * the spike probability/size for how often an escalation should plausibly
 * occur across a multi-day stay's handful of rounds. */
function walkSeverity(current: number, seed: string): number {
  const drift = (seededRandom(`${seed}:drift`) - 0.55) * 0.1;
  const spikeRoll = seededRandom(`${seed}:spike`);
  const spike = spikeRoll > 0.92 ? ((spikeRoll - 0.92) / 0.08) * 0.35 : 0;
  return clamp01(current + drift + spike);
}

function severityVitals(kind: StationKind, severity: number, seed: string): Record<string, number> {
  const r = VITALS_RANGES[kind];
  const jitter = (seededRandom(`${seed}:jitter`) - 0.5) * 0.12;
  const s = clamp01(severity + jitter);
  return {
    heartRate: Math.round(r.hr[0] + (r.hr[1] - r.hr[0]) * s),
    spo2: Math.round(r.spo2[1] - (r.spo2[1] - r.spo2[0]) * s),
    respRate: Math.round(r.resp[0] + (r.resp[1] - r.resp[0]) * s),
    temperature: Math.round((r.temp[0] + (r.temp[1] - r.temp[0]) * s) * 10) / 10,
  };
}

function nursingNoteFor(severity: number): string {
  if (severity > NURSE_CALLS_DOCTOR_THRESHOLD) return 'Patient zeigt Zeichen der Verschlechterung (unruhig, reduzierter Allgemeinzustand) - Arzt informiert.';
  if (severity > 0.45) return 'Patient stabil, leicht reduzierter Allgemeinzustand, Mobilisation nach Plan.';
  return 'Patient stabil, guter Allgemeinzustand, Mobilisation fortgeschritten, keine Auffälligkeiten.';
}

function doctorOrderFor(severity: number): { serviceName: string; serviceType: string; urgency: string; clinicalIndication: string; comment: string } {
  if (severity > ESCALATION_THRESHOLD) {
    return {
      serviceName: 'Akute Reevaluation', serviceType: 'Konsil', urgency: 'at0136',
      clinicalIndication: 'Klinische Verschlechterung im Verlauf, Verdacht auf Komplikation.',
      comment: 'Sofortige ärztliche Re-Evaluation, Verlegung auf höhere Versorgungsstufe geprüft und veranlasst.',
    };
  }
  if (severity > 0.55) {
    return {
      serviceName: 'Laborkontrolle', serviceType: 'Labor', urgency: 'at0137',
      clinicalIndication: 'Grenzwertige Vitalparameter, engmaschige Kontrolle erforderlich.',
      comment: 'Laborkontrolle und erneute Visite innerhalb von 6 Stunden.',
    };
  }
  return {
    serviceName: 'Verlaufskontrolle', serviceType: 'Visite', urgency: 'at0138',
    clinicalIndication: 'Regelhafte ärztliche Verlaufsbeurteilung im Rahmen der Visite.',
    comment: 'Weiter nach Standardprotokoll, nächste Visite regulär.',
  };
}

function labFindingsFor(severity: number): { conclusion: string; testDiagnosis?: string } {
  if (severity > 0.7) return { conclusion: 'Hb erniedrigt, Leukozyten deutlich erhöht, CRP erhöht - Hinweis auf Infektion/Sepsis.', testDiagnosis: 'V.a. Sepsis' };
  if (severity > 0.45) return { conclusion: 'Leichte Anämie, grenzwertig erhöhte Entzündungswerte.' };
  return { conclusion: 'Laborwerte im Normbereich.' };
}

/** Parses the scenario's own descriptive `at:` offsets ("27h", "45m",
 * "0h") into minutes - the only clock this whole workbench has, since
 * execution itself always uses real wall-clock timestamps (see
 * `locationLog.ts`'s own doc comment on why that's the honest choice). */
function parseAt(at: string): number {
  const match = /^(\d+)(h|m)$/.exec(at.trim());
  if (!match) return 0;
  const amount = Number(match[1]);
  return match[2] === 'h' ? amount * 60 : amount;
}

function formatAt(minutes: number): string {
  return minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes)}m`;
}

function isStationEvent(event: ScenarioEvent): boolean {
  return event.type === 'patient-arrival' || event.type === 'ward-transfer';
}

function stationLocation(event: ScenarioEvent): { key: string; name: string; description?: string; kind?: string } | undefined {
  return event.data?.location as { key: string; name: string; description?: string; kind?: string } | undefined;
}

function buildLeafEvent(id: string, at: string, action: 'vitals' | 'nursing' | 'lab', kind: StationKind, severity: number): ScenarioEvent {
  if (action === 'vitals') return { id, type: 'vital-signs', at, data: severityVitals(kind, severity, id) };
  if (action === 'nursing') return { id, type: 'nursing-round', at, data: { note: nursingNoteFor(severity) } };
  return { id, type: 'lab-result', at, data: labFindingsFor(severity) };
}

function buildDoctorEvent(id: string, at: string, severity: number): ScenarioEvent {
  const order = doctorOrderFor(severity);
  return { id, type: 'doctor-round', at, data: { ...order, dueAt: undefined } };
}

function buildNoteEvent(id: string, at: string, stationName: string): ScenarioEvent {
  return { id, type: 'anamnesis', at, data: { diagnosis: `${stationName}: Verlaufsnotiz (automatisch generiert)` } };
}

/** Synthesizes a real ward-transfer to `kind`, reusing the exact
 * location/staff the scenario itself already used the last time it
 * visited a station of that kind (same real Practitioner, same real local
 * Station) - an escalation never invents a new place or person, only
 * reuses one the scenario author already named. Returns undefined (no
 * escalation possible) if the scenario never actually visited that kind
 * before. */
function buildEscalationTransfer(scenario: Scenario, upToIndex: number, kind: StationKind, id: string, at: string): ScenarioEvent | undefined {
  for (let i = upToIndex; i >= 0; i -= 1) {
    const candidate = scenario.events[i];
    if (!isStationEvent(candidate)) continue;
    const location = stationLocation(candidate);
    if (location?.kind !== kind) continue;
    return { id, type: 'ward-transfer', at, data: { encounterStatus: 'in-progress', location, staff: candidate.data?.staff } };
  }
  return undefined;
}

interface TimelineSlot {
  atMinutes: number;
  action: 'vitals' | 'nursing' | 'doctor';
  idSuffix: string;
}

/** Turns a scenario's own short, high-level station list into the full
 * concrete event list its stations' own protocols imply - called once by
 * `loader.ts`'s `loadScenario`, so every consumer (Step/Play, the Timeline,
 * the Klinik graph's own step counts) automatically sees the expanded
 * version. A station with no `data.location.kind` (every station in the
 * original LAE demo) passes through completely unexpanded. */
export function expandScenario(scenario: Scenario): Scenario {
  const events: ScenarioEvent[] = [];
  let severity = 0.3;
  let escalationsUsed = 0;

  for (let i = 0; i < scenario.events.length; i += 1) {
    const event = scenario.events[i];
    events.push(event);
    if (!isStationEvent(event)) continue;

    const kind = stationLocation(event)?.kind as StationKind | undefined;
    const protocol = kind ? STATION_PROTOCOLS[kind] : undefined;
    if (!kind || !protocol) continue;

    severity = nudgeTowardBaseline(severity, kind);
    const admissionMinutes = parseAt(event.at);
    const nextStationEvent = scenario.events.slice(i + 1).find(isStationEvent);
    const dischargeMinutes = nextStationEvent ? parseAt(nextStationEvent.at) : admissionMinutes;
    const stayMinutes = Math.max(0, dischargeMinutes - admissionMinutes);

    // onAdmission actions happen immediately, in declared order.
    for (const action of protocol.onAdmission) {
      const id = `${event.id}-admit-${action}`;
      severity = walkSeverity(severity, id);
      if (action === 'note') events.push(buildNoteEvent(id, formatAt(admissionMinutes), stationLocation(event)?.name ?? 'Station'));
      else events.push(buildLeafEvent(id, formatAt(admissionMinutes), action as 'vitals' | 'lab', kind, severity));
    }

    // Periodic vitals + nursing/doctor rounds, all merged into one
    // time-ordered slot list so the severity walk (and any escalation it
    // triggers) reflects the real chronological order of the stay, not
    // "all vitals, then all nursing rounds" batches.
    const slots: TimelineSlot[] = [];
    if (protocol.vitalsIntervalMinutes) {
      const count = Math.min(protocol.vitalsMaxOccurrences, Math.max(0, Math.floor(stayMinutes / protocol.vitalsIntervalMinutes) - 1));
      for (let n = 1; n <= count; n += 1) slots.push({ atMinutes: admissionMinutes + n * protocol.vitalsIntervalMinutes, action: 'vitals', idSuffix: `interval-${n}` });
    }
    if (protocol.nursingRoundsPerDay) {
      const count = Math.min(protocol.maxRoundsPerStay, Math.floor((stayMinutes / 1440) * protocol.nursingRoundsPerDay));
      const spacing = stayMinutes / (count + 1);
      for (let n = 1; n <= count; n += 1) slots.push({ atMinutes: admissionMinutes + n * spacing, action: 'nursing', idSuffix: `nursing-${n}` });
    }
    if (protocol.doctorRoundsPerDay) {
      const count = Math.min(protocol.maxRoundsPerStay, Math.floor((stayMinutes / 1440) * protocol.doctorRoundsPerDay));
      const spacing = stayMinutes / (count + 1);
      for (let n = 1; n <= count; n += 1) slots.push({ atMinutes: admissionMinutes + n * spacing, action: 'doctor', idSuffix: `doctor-${n}` });
    }
    slots.sort((a, b) => a.atMinutes - b.atMinutes);

    let escalated = false;
    for (const slot of slots) {
      const id = `${event.id}-${slot.idSuffix}`;
      severity = walkSeverity(severity, id);
      const at = formatAt(slot.atMinutes);

      if (slot.action === 'doctor') {
        events.push(buildDoctorEvent(id, at, severity));
      } else if (slot.action === 'nursing') {
        events.push(buildLeafEvent(id, at, 'nursing', kind, severity));
        if (severity > NURSE_CALLS_DOCTOR_THRESHOLD) {
          const calledId = `${id}-calls-doctor`;
          severity = walkSeverity(severity, calledId);
          events.push(buildDoctorEvent(calledId, at, severity));
        }
      } else {
        events.push(buildLeafEvent(id, at, 'vitals', kind, severity));
      }

      // Only a doctor-authored decision (an original scheduled round, or
      // one a severe nursing round just called in) ever escalates - a
      // nurse's own note never directly moves the patient.
      const lastEventWasDoctor = events[events.length - 1].type === 'doctor-round';
      if (lastEventWasDoctor && severity > ESCALATION_THRESHOLD && protocol.escalatesTo && escalationsUsed < MAX_ESCALATIONS) {
        const escalation = buildEscalationTransfer(scenario, i, protocol.escalatesTo, `${id}-escalation`, at);
        if (escalation) {
          events.push(escalation);
          escalationsUsed += 1;
          escalated = true;
          break; // the patient has left this station - no further actions here
        }
      }
    }

    // A patient who escalated out mid-stay doesn't get a normal discharge
    // from the place they were transferred OUT of under crisis.
    if (!escalated) {
      for (const action of protocol.onDischarge) {
        const id = `${event.id}-discharge-${action}`;
        severity = walkSeverity(severity, id);
        const at = formatAt(Math.max(admissionMinutes, dischargeMinutes - 1));
        if (action === 'note') events.push(buildNoteEvent(id, at, stationLocation(event)?.name ?? 'Station'));
        else events.push(buildLeafEvent(id, at, action as 'vitals' | 'lab', kind, severity));
      }
    }
  }

  return { ...scenario, events };
}
