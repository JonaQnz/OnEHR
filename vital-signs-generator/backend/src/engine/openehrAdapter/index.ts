import type { Scenario, Timepoint } from '../../../../shared/types';

/** A field's runtime value shape, exactly as `PATCH /api/form-sessions/:id`
 * expects it (the "runtime"/FLAT-adjacent shape, not the canonical RM
 * shape the server derives from it - see packages/openehr-engine's own
 * DV_QUANTITY/DV_PROPORTION handling for how {magnitude,unit}/{numerator}
 * become real RM structures server-side). */
export type RuntimeValue = string | { magnitude: number; unit: string } | { numerator: number; denominator?: number };

/** The seam between the openEHR-unaware engine and a concrete Form
 * Section's field ids. `vitalSignsAdapter.ts` is the only file that knows
 * any at-code or field id - a future "different vitals template" swap is
 * a new file implementing this same interface, with zero changes to
 * engine/timeline.ts or engine/signalModels/tracks. */
export interface OpenEhrAdapter {
  /** The published "Vitalzeichen" Form Section's own id (compositionContext.blockId's target). */
  formSectionId: string;
  /** The published wrapping Composition's id (compositionFormId for POST /api/composition-sessions). */
  compositionFormId: string;
  /** The wrapping Composition's block id this Form Section is attached under (see Phase 1: 'vitals_block'). */
  blockId: string;
  toFormSessionValues(timepoint: Timepoint, scenario: Scenario): Record<string, RuntimeValue>;
}

/**
 * Deliberately not implemented yet - true multi-event HISTORY support (one
 * OBSERVATION per track holding every sample, instead of one Composition
 * per timepoint) is blocked on a core-engine gap: `buildObservationData`
 * in packages/openehr-engine/src/canonicalComposition.ts always builds
 * exactly one event per OBSERVATION, and there is no read-side HISTORY/
 * EVENT parser at all. When that lands, a History/Batch adapter would add
 * a second method here, e.g.:
 *
 *   toHistoryOperations(timepoints: Timepoint[], scenario: Scenario): unknown[];
 *
 * producing one multi-event submission per OBSERVATION instead of the
 * Snapshot-mode per-timepoint Composition sequence
 * (engine/submission/compositionRunner.ts) this project actually uses.
 */
