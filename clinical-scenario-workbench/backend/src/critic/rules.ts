import type { Scenario, ScenarioEvent } from '../scenario/types';

/**
 * User's ask: "bei jedem Schritt ein System [soll] die Eingaben überwachen
 * und kritisieren [...] Dass Dinge fehlen [...] und daraus Tasks erstellen."
 * Concrete trigger: reviewing the appendicitis case ("appendizitis-lena")
 * live, the user immediately spotted three real gaps by eye - no
 * structured diagnostic finding for the booked ultrasound (only a free-text
 * Appointment comment), no structured Procedure record for the actual
 * appendectomy, no dedicated OP booking. Those three are now fixed in the
 * scenario file itself (`diagnostic-report`/`procedure` events, a real
 * `op-scheduling` request-imaging booking) - this module is the *standing*
 * version of the same eye: a small, deterministic ruleset that inspects the
 * scenario's own fully-expanded event list (protocol.ts's `expandScenario`
 * already ran by the time this sees it) and flags the clinically real gaps
 * a hospital course would not actually skip, whether or not this specific
 * scenario happens to have fixed them.
 *
 * Deliberately NOT an LLM judgment call - every finding here is a plain,
 * explainable structural check ("no `procedure` event between this surgery
 * ward-transfer and the next station"), in the same spirit as protocol.ts's
 * own deterministic rulesets. `anchorEventId` says WHEN this finding
 * becomes true during a real play-through - `engine.ts`'s `executeNextEvent`
 * surfaces a finding as a real Task the moment its anchor event completes,
 * so gaps appear incrementally as the case progresses ("bei jedem
 * Schritt"), not all at once at the end.
 */
export interface CritiqueFinding {
  /** Stable across re-runs of the identical scenario - `${code}:${anchorEventId}` -
   * used as the Task's own id so re-playing a step never duplicates one. */
  code: string;
  anchorEventId: string;
  description: string;
}

function isStationEvent(event: ScenarioEvent): boolean {
  return event.type === 'patient-arrival' || event.type === 'ward-transfer';
}

function stationLocation(event: ScenarioEvent): { key: string; name?: string; kind?: string } | undefined {
  return event.data?.location as { key: string; name?: string; kind?: string } | undefined;
}

/** Found live reviewing the pregnancy-ANC-visit case: the discharge-time
 * checks below (letter/follow-up/medication) all assume a stationary stay
 * that ends in a real "Entlassung" - correct for Polytrauma/Herzinfarkt/
 * Appendizitis, but wrong for a routine ambulatory visit (a scheduled
 * antenatal check-up, say), which was never "discharged" in the first
 * place and firing these three there is a critic-model gap, not a real
 * documentation gap. Detected off the arrival event's own `classCode`
 * (HL7 v3 ActCode - "AMB" = ambulatory, same field engine.ts's own
 * `patient-arrival` handler already reads/defaults to "EMER") rather than
 * inventing a second signal - a scenario that never sets classCode (every
 * existing inpatient scenario) is unaffected, matching today's behavior
 * exactly. `missing-coded-diagnosis` stays unconditional - a real
 * diagnosis should be coded regardless of setting. */
function isAmbulatoryEncounter(events: ScenarioEvent[]): boolean {
  const arrival = events.find((event) => event.type === 'patient-arrival');
  return arrival?.data?.classCode === 'AMB';
}

/** A pure function of the (already fully expanded) scenario - never reads
 * live execution state, so it can be computed once and consulted by
 * anchorEventId as the run actually progresses. */
export function critiqueScenario(scenario: Scenario): CritiqueFinding[] {
  const events = scenario.events;
  const findings: CritiqueFinding[] = [];

  // Rule: allergy/current-medication history. No capability in this
  // workbench captures this today (anamnesis only records a diagnosis) -
  // a real admission never skips it, so this always fires once, right at
  // arrival, until a real capability for it exists.
  const arrival = events.find((event) => event.type === 'patient-arrival');
  if (arrival) {
    findings.push({
      code: 'missing-allergy-history',
      anchorEventId: arrival.id,
      description: 'Allergien und Dauermedikation wurden bei Aufnahme nicht strukturiert erfasst.',
    });
  }

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (!isStationEvent(event)) continue;
    const location = stationLocation(event);
    if (location?.kind !== 'surgery') continue;

    const nextStationIndex = events.findIndex((candidate, idx) => idx > i && isStationEvent(candidate));
    const boundary = nextStationIndex === -1 ? events.length : nextStationIndex;
    const between = events.slice(i + 1, boundary);
    const anchor = nextStationIndex === -1 ? events[events.length - 1] : events[nextStationIndex];
    const stationName = location.name ?? event.id;

    // No informed-consent capability exists anywhere in this workbench -
    // a real surgery is never performed without one on file.
    findings.push({
      code: `missing-consent:${event.id}`,
      anchorEventId: event.id,
      description: `Keine dokumentierte Aufklärung/Einwilligung vor dem Eingriff an Station "${stationName}".`,
    });

    if (!between.some((candidate) => candidate.type === 'procedure')) {
      findings.push({
        code: `missing-procedure-record:${event.id}`,
        anchorEventId: anchor.id,
        description: `Kein strukturierter Prozedur-Eintrag für den Eingriff an Station "${stationName}" gefunden.`,
      });
    }

    // Per-station checklist item (user's ask: "erweitere die Todos auf pro
    // Station"): an interventional station (OP, Herzkatheterlabor, ...)
    // never proceeds without SOME peri-procedural medication already given
    // (antiplatelet/anticoagulation before a PCI, antibiotic prophylaxis
    // before a laparotomy, sedation/analgesia before a minor procedure) -
    // checked against the WHOLE scenario up to and including this station
    // (not just "between stations" like the two rules above), since the
    // medication is often given before the actual transfer into the room.
    if (!events.slice(0, i + 1).some((candidate) => candidate.type === 'medication-administration')) {
      findings.push({
        code: `missing-preprocedure-medication:${event.id}`,
        anchorEventId: event.id,
        description: `Keine periprozedurale Medikamentengabe vor dem Eingriff an Station "${stationName}" dokumentiert.`,
      });
    }
  }

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.type !== 'request-imaging') continue;
    if (event.data?.expectsDiagnosticReport !== true) continue;

    const nextStationIndex = events.findIndex((candidate, idx) => idx > i && isStationEvent(candidate));
    const boundary = nextStationIndex === -1 ? events.length : nextStationIndex;
    const between = events.slice(i + 1, boundary);
    const anchor = nextStationIndex === -1 ? events[events.length - 1] : events[nextStationIndex];
    const serviceName = typeof event.data?.serviceName === 'string' ? event.data.serviceName : event.id;

    if (!between.some((candidate) => candidate.type === 'diagnostic-report')) {
      findings.push({
        code: `missing-diagnostic-report:${event.id}`,
        anchorEventId: anchor.id,
        description: `Für die Diagnostik "${serviceName}" liegt kein strukturierter Befund vor (nur ein Freitext-Kommentar im Termin).`,
      });
    }
  }

  // Discharge-time checks, anchored to the scenario's own last event - only
  // meaningful for a stationary stay that actually ends in a discharge (see
  // isAmbulatoryEncounter's own doc comment above).
  const last = events[events.length - 1];
  if (last && !isAmbulatoryEncounter(events)) {
    // `discharge-letter` is a real, checkable capability (unlike the other
    // two below) - only flagged when the scenario genuinely never wrote one.
    if (!events.some((event) => event.type === 'discharge-letter')) {
      findings.push({
        code: 'missing-discharge-letter',
        anchorEventId: last.id,
        description: 'Kein Arztbrief/Entlassungsbrief zur Entlassung erstellt.',
      });
    }
    // A follow-up appointment is cheap to check for real - it's just
    // another `request-imaging` booking (the same generic HealthcareService/
    // Schedule/Slot/Appointment chain already used for imaging/OP bookings),
    // opted into via `data.isFollowUp: true` the same way `diagnostic-report`
    // expectations are opted into via `expectsDiagnosticReport`.
    if (!events.some((event) => event.type === 'request-imaging' && event.data?.isFollowUp === true)) {
      findings.push({
        code: 'missing-followup-appointment',
        anchorEventId: last.id,
        description: 'Kein Nachsorgetermin nach der Entlassung vereinbart.',
      });
    }
    // `discharge-medication` is now ALSO a real, checkable capability
    // (Entlassmedikation) - same pattern as discharge-letter above.
    if (!events.some((event) => event.type === 'discharge-medication')) {
      findings.push({
        code: 'missing-discharge-medication',
        anchorEventId: last.id,
        description: 'Keine Entlassmedikation dokumentiert.',
      });
    }
  }
  if (last) {
    // A formal, ICD-10-GM-coded diagnosis is distinct from the free-text
    // anamnesis note - a real discharge always has one on file for billing/
    // coding purposes, even if the narrative diagnosis was already clear
    // from the very first anamnesis. Now a real, checkable capability
    // ("coded-diagnosis", via "Diagnose (Basis)" - see capability/catalog.ts's
    // own doc comment for the live-verified writeup), same pattern as
    // discharge-letter/discharge-medication above.
    if (!events.some((event) => event.type === 'coded-diagnosis')) {
      findings.push({
        code: 'missing-coded-diagnosis',
        anchorEventId: last.id,
        description: 'Keine formal kodierte (ICD-10-GM) Diagnose im Verlauf dokumentiert.',
      });
    }
  }

  return findings;
}
