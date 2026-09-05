/**
 * Terminology integration contract (Block 2 of the field-rule/terminology
 * initiative - see the "Terminologie-Server-Integration" plan). Deliberately
 * modeled after `FormDataProvider` (packages/core/src/form-data): a neutral
 * Core contract, a plugin registers a concrete implementation via
 * `context.registerTerminologyProvider()` (plugin-api), and
 * `apps/api/src/services/terminologyProviderRegistry.ts` resolves by id -
 * exactly the same "Core knows the shape, a plugin knows the backend"
 * split that already keeps EHRbase/n8n data providers decoupled (see
 * [[n8n-provider-moved-into-plugin]]).
 *
 * The naming here is deliberately NOT FHIR-standardized (`namespace`, not
 * `system`; `bindingId`, not `valueSetUrl`) - Core must not know it's
 * talking to a FHIR terminology server at all. A concrete provider (the
 * HAPI plugin) is responsible for translating these neutral terms onto its
 * own backend's vocabulary; see that plugin's own doc comments for the
 * translation table. This is a real, deliberate choice, not an oversight -
 * a future non-FHIR provider (a plain internal REST catalog, say) never
 * needs to learn FHIR concepts to implement this interface.
 *
 * This is NOT the shape a field's runtime value takes - that remains the
 * existing, already-wire-compatible `CodeMappingValue`
 * (packages/core/src/canonical), extended with optional `version`/`display`
 * (see that type's own doc comment for why it isn't replaced here).
 */

/** A concept as returned by search/lookup/validate - purely a Provider
 * Abstraction Layer shape, never persisted verbatim as a field's value. */
export interface TerminologyConcept {
  namespace: string;
  namespaceVersion?: string;
  code: string;
  /** Not every provider/expansion guarantees a display term. */
  display?: string;
  definition?: string;
  /** Missing/undefined is treated as active. Only gates whether search()
   * offers this concept for NEW entries - lookup() of a historically
   * stored, now-inactive code must still succeed (see FormRuntime's
   * inactive-code handling doc comment). */
  active?: boolean;
}

export interface TerminologySearchInput {
  bindingId?: string;
  bindingVersion?: string;
  namespace?: string;
  namespaceVersion?: string;
  query: string;
  limit?: number;
  /** Default true when omitted - see TerminologyConcept.active. */
  activeOnly?: boolean;
}

export interface TerminologyLookupInput {
  namespace: string;
  namespaceVersion?: string;
  code: string;
}

export interface TerminologyValidateInput {
  namespace?: string;
  namespaceVersion?: string;
  bindingId?: string;
  bindingVersion?: string;
  code: string;
}

/** A typed outcome, not a plain `{valid: boolean}` - a code that's
 * genuinely invalid and a provider that's merely unreachable must never be
 * conflated (a bare boolean would make a network blip look identical to
 * "this code doesn't exist"). `validationPolicy` (below) is defined
 * entirely in terms of this distinction. */
export type TerminologyValidationOutcome =
  | { status: 'valid'; concept: TerminologyConcept }
  | { status: 'invalid-code' }
  | { status: 'unknown-namespace' }
  | { status: 'unknown-binding' }
  | { status: 'unknown-version' }
  | { status: 'unreachable'; message?: string }
  | { status: 'provider-error'; message?: string };

/**
 * How a field's terminology binding is enforced at submission time -
 * replaces a boolean `allowUnverifiedCode` flag, which couldn't express
 * "block on a genuinely bad code, but don't block just because the server
 * hiccuped".
 *
 * - `required`: the code must successfully validate; either an
 *   `invalid-code` outcome OR an unreachable/erroring provider blocks
 *   submission.
 * - `best-effort`: an `invalid-code` outcome still blocks, but
 *   `unreachable`/`provider-error` only warns and lets the clinician
 *   continue.
 * - `none`: no server-side validation is performed at all; the provider
 *   may still be used for search/autocomplete.
 *
 * Default for a newly configured clinical terminology binding: `required`.
 */
export type TerminologyValidationPolicy = 'required' | 'best-effort' | 'none';

/** Something a field can be bound to - a named, versioned set of concepts
 * (a FHIR ValueSet, in the HAPI plugin's translation). Named "binding", not
 * "ValueSet", so a non-FHIR provider can implement this without adopting
 * FHIR vocabulary. Returned by `discover.searchBindings` so the Designer
 * never needs to type a canonical URI by hand. */
export interface TerminologyBindingSummary {
  bindingId: string;
  label: string;
  namespace?: string;
  bindingVersion?: string;
  conceptCount?: number;
}

/** Extends `TerminologyBindingSummary` with the lifecycle a self-authored
 * (`manage`-capable) terminology additionally carries. The Terminology
 * Admin UI (`apps/web/src/pages/TerminologyAdmin.tsx`) works exclusively
 * off this shape - it never reconstructs a provider-internal canonical URI
 * itself.
 *
 * `terminologyId` vs `bindingId`/`bindingVersion`: a custom terminology is a
 * *family* of business versions (draft → published → retired → next draft
 * → ...), all sharing one stable identity a form/admin-UI action refers to
 * regardless of which concrete version is current. `terminologyId` is that
 * stable family id (what `manage.createTerminology`'s `input.id` becomes,
 * and what every other `manage.*` method's `terminologyId` parameter
 * expects); `bindingId`/`bindingVersion` (inherited from
 * `TerminologyBindingSummary`) describe the *current* version's own
 * concrete, bindable identity - what a field's `bindingId`/`bindingVersion`
 * config actually pins against. These are deliberately not the same value:
 * publishing a new version changes `bindingVersion` (and may change
 * `bindingId`, depending on the provider) while `terminologyId` never
 * changes. */
export interface CustomTerminologySummary extends TerminologyBindingSummary {
  terminologyId: string;
  status: 'draft' | 'published' | 'retired';
  /** The current resource's revision token - what a caller must pass back
   * as `manage.upsertConcept`/`removeConcept`'s `expectedRevision` for their
   * *next* edit (optimistic locking, see `TerminologyProvider.manage`'s own
   * doc comment). Every `manage` method that returns a
   * `CustomTerminologySummary` returns the revision current as of that
   * call - callers should always use the freshest one they've seen, never
   * a stale cached value. */
  revision: string;
}

export interface TerminologyProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly ('search' | 'lookup' | 'validate' | 'discover' | 'manage')[];
  search(input: TerminologySearchInput): Promise<TerminologyConcept[]>;
  lookup(input: TerminologyLookupInput): Promise<TerminologyConcept | undefined>;
  validate(input: TerminologyValidateInput): Promise<TerminologyValidationOutcome>;
  /** Only present when `capabilities` includes `'discover'` - lets the
   * Designer browse/pick a binding (an ICD-10-GM year version, a custom
   * list, ...) instead of typing a URI by hand. */
  discover?: {
    searchBindings(query: string): Promise<TerminologyBindingSummary[]>;
    getBinding(bindingId: string, bindingVersion?: string): Promise<TerminologyBindingSummary | undefined>;
  };
  /** Only present when `capabilities` includes `'manage'` - CRUD + lifecycle
   * for self-authored ("custom") terminologies. */
  manage?: {
    listTerminologies(): Promise<CustomTerminologySummary[]>;
    createTerminology(input: { id: string; label: string }): Promise<CustomTerminologySummary>;
    listConcepts(terminologyId: string): Promise<TerminologyConcept[]>;
    /**
     * `expectedRevision` is optimistic-locking, not decoration - two
     * parallel admin sessions editing the same draft must not silently
     * overwrite one another; a stale `expectedRevision` must be rejected
     * (structured error, same shape/pattern as `FormDataProvider`'s own
     * thrown errors - see `isFormDataProviderError`). Also rejects when the
     * terminology's current business version is `'published'`/`'retired'`
     * - only a `'draft'` version's concepts may be mutated; publishing
     * freezes it and any further edit implicitly opens a new draft on top,
     * never rewrites the published one.
     */
    upsertConcept(terminologyId: string, concept: TerminologyConcept, expectedRevision: string): Promise<{ revision: string }>;
    removeConcept(terminologyId: string, code: string, expectedRevision: string): Promise<{ revision: string }>;
    /** Freezes the current draft as an immutable published business
     * version. */
    publishVersion(terminologyId: string): Promise<CustomTerminologySummary>;
    /** Marks a specific, already-published version as retired - it stays
     * readable/lookup-able (historical bindings must keep working) but is
     * no longer offered as a bindable version for new field configuration. */
    retireVersion(terminologyId: string, version: string): Promise<CustomTerminologySummary>;
  };
}

/**
 * The shape a `TerminologyProvider.manage.*` call's own thrown errors are
 * expected to carry - mirrors `FormDataProviderError`/`isFormDataProviderError`
 * exactly (packages/core/src/form-data/index.ts), for the same reason: a
 * caller (apps/api's generic terminologyRoutes.ts) detects this structurally
 * via `isTerminologyManageError()`, never via `instanceof` a specific
 * provider's own error class, so a provider living in its own plugin package
 * (e.g. formbuilder-plugin-hapi-terminology) never has to be imported by the
 * generic route dispatcher.
 *
 * Found live (2026-09-05): this type/guard was documented as the intended
 * design in `upsertConcept`'s own doc comment above ("structured error, same
 * shape/pattern as FormDataProvider's own thrown errors") but never actually
 * existed - terminologyRoutes.ts had no way to recognize a revision conflict
 * (or any other manage.* error) as anything other than an opaque exception,
 * so `errorHandler.ts`'s deliberate "only an HttpError's message is
 * client-facing" safety net (see its own comment) flattened every one of
 * them into a useless "Unexpected server error" with status 500 - including
 * a genuine, already-well-messaged optimistic-locking conflict between two
 * concurrent admin sessions, confirmed via a live two-session upsert race.
 */
export interface TerminologyManageError extends Error {
  status?: number;
  code: string;
}

export function isTerminologyManageError(error: unknown): error is TerminologyManageError {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}
