import { buildTimepoints } from '../timeline';
import type { Scenario, Timepoint } from '../../../../shared/types';

/** Zero HTTP calls - literally `buildTimepoints`, formatted for the
 * preview chart. Backs both the frontend's live preview and the test
 * suite; `compositionRunner.ts`'s real generation run calls the exact
 * same `buildTimepoints`, so "what you previewed is what gets submitted"
 * is structural, not something that has to be kept in sync by hand. */
export function dryRun(scenario: Scenario): Timepoint[] {
  return buildTimepoints(scenario);
}
