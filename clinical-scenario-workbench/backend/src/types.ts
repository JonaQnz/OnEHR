/** Cross-cutting types shared by several modules - kept here instead of
 * duplicated per-module so entity/capability/resource-form code all agree on
 * one Provenance shape (spec section 7/24/25). */

/** Where a value came from - drives the "never silently overwrite a USER
 * value" rule (spec section 38: USER > SOURCE > DERIVED > GENERATED). */
export type Provenance = 'SOURCE' | 'DERIVED' | 'GENERATED' | 'USER';

export const PROVENANCE_PRIORITY: Record<Provenance, number> = {
  USER: 3,
  SOURCE: 2,
  DERIVED: 1,
  GENERATED: 0,
};

/** True when `next` is allowed to replace a value currently carrying
 * `current` provenance - i.e. `next` outranks (or equals) `current`. A plain
 * equal-rank replacement (e.g. re-deriving the same DERIVED fact) is allowed;
 * only a strictly lower-priority source is refused. */
export function mayOverwrite(current: Provenance, next: Provenance): boolean {
  return PROVENANCE_PRIORITY[next] >= PROVENANCE_PRIORITY[current];
}
