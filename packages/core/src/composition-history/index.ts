/**
 * openEHR Composition version history & audit metadata - the internal,
 * CDR-independent model (Epic 3). No UI component and no route handler
 * should interpret raw openEHR/EHRbase JSON directly; everything goes
 * through `CompositionVersion` and the normalizers below.
 *
 * Two honesty flags mirror Epic 2's `FormSession.lifecycleConfirmed`:
 * `lifecycleConfirmed`/`changeTypeConfirmed` are true only when the value
 * came from a source we trust for that field (see the connector - the real
 * EHRbase deployment this app talks to reads back `lifecycle_state` as
 * `complete` on every version regardless of what was actually saved, so a
 * value we can't independently confirm must say so, never silently pass as
 * fact).
 */

export type CompositionLifecycleState = 'incomplete' | 'complete' | 'deleted' | 'unknown';

export type CompositionChangeType =
  | 'creation'
  | 'modification'
  | 'amendment'
  | 'deleted'
  | 'attestation'
  | 'unknown';

export interface PartyReference {
  name?: string;
  id?: string;
}

export interface CompositionVersion {
  compositionUid: string;
  versionUid: string;

  /** Convenience only, parsed from the trailing `::N` of versionUid for
   * display/sorting - versionUid remains the source of truth (never reduce
   * a version tree id to this alone; see the spec's own §3). */
  versionNumber?: number;

  lifecycleState: CompositionLifecycleState;
  /** Whether lifecycleState is known to reflect what the CDR (or Forms'
   * own local record) actually captured, vs. an unconfirmed default. */
  lifecycleConfirmed: boolean;

  changeType: CompositionChangeType;
  changeTypeConfirmed: boolean;

  committedAt?: string;
  committer?: PartyReference;
  /** COMPOSITION.composer - distinct from commit_audit.committer; only
   * available once the full version content has been fetched (§5). */
  composer?: PartyReference;

  changeDescription?: string;

  contributionUid?: string;
  precedingVersionUid?: string;

  raw?: unknown;
}

const LIFECYCLE_CODES: Record<string, CompositionLifecycleState> = {
  '553': 'incomplete',
  '532': 'complete',
  '523': 'deleted',
};

const CHANGE_TYPE_CODES: Record<string, CompositionChangeType> = {
  '249': 'creation',
  '251': 'modification',
  '250': 'amendment',
  '523': 'deleted',
  // Confirmed unconfirmed against an authoritative enumeration; kept as a
  // best-effort guess consistent with the rest of this app's change_type
  // handling (see EhrbaseDataProvider.buildAuditHeaders) - never trusted
  // blindly, always paired with the `value` text field when present.
  '666': 'attestation',
};

function normalizeByValueThenCode<T extends string>(
  value: string | undefined,
  codeString: string | undefined,
  valueMap: Record<string, T>,
  codeMap: Record<string, T>,
): T {
  const byValue = value && valueMap[value.toLowerCase()];
  if (byValue) return byValue;
  const byCode = codeString && codeMap[codeString];
  if (byCode) return byCode;
  return 'unknown' as T;
}

/** Normalizes an openEHR lifecycle_state (DV_CODED_TEXT `value`/`defining_code.code_string`)
 * into the app's internal, template-independent lifecycle union. Robust to
 * unrecognized codes - never throws. */
export function mapLifecycleState(value?: string, codeString?: string): CompositionLifecycleState {
  return normalizeByValueThenCode(
    value,
    codeString,
    { incomplete: 'incomplete', complete: 'complete', deleted: 'deleted' },
    LIFECYCLE_CODES,
  );
}

/** Normalizes an openEHR AUDIT_DETAILS.change_type into the app's internal
 * union. Robust to unrecognized codes - never throws. */
export function mapChangeType(value?: string, codeString?: string): CompositionChangeType {
  return normalizeByValueThenCode(
    value,
    codeString,
    { creation: 'creation', modification: 'modification', amendment: 'amendment', deleted: 'deleted', attestation: 'attestation' },
    CHANGE_TYPE_CODES,
  );
}

export const LIFECYCLE_STATE_LABELS: Record<CompositionLifecycleState, string> = {
  incomplete: 'Entwurf',
  complete: 'Finalisiert',
  deleted: 'Zurückgezogen',
  unknown: 'Unbekannt',
};

export const CHANGE_TYPE_LABELS: Record<CompositionChangeType, string> = {
  creation: 'Erstellt',
  modification: 'Aktualisiert',
  amendment: 'Korrigiert',
  deleted: 'Zurückgezogen',
  attestation: 'Attestiert',
  unknown: 'Unbekannt',
};

/** The trailing `::N` of a full `{uid}::{system}::{version}` version uid,
 * for display/sort convenience only - see CompositionVersion.versionNumber. */
export function parseVersionNumber(versionUid: string | undefined): number | undefined {
  if (!versionUid) return undefined;
  const match = versionUid.match(/::(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

export interface SemanticDiffEntry {
  path: string;
  archetypeNodeId?: string;
  rmType?: string;
  label?: string;
  oldValue?: unknown;
  newValue?: unknown;
  change: 'added' | 'removed' | 'changed';
}

export interface SemanticDiff {
  added: SemanticDiffEntry[];
  removed: SemanticDiffEntry[];
  changed: SemanticDiffEntry[];
}

export interface DiffSummary {
  changed: number;
  added: number;
  removed: number;
}

export function summarizeDiff(diff: SemanticDiff): DiffSummary {
  return { changed: diff.changed.length, added: diff.added.length, removed: diff.removed.length };
}
