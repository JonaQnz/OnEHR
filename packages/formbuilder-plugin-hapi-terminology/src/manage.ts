/**
 * CRUD + lifecycle for self-authored ("custom") terminologies -
 * `TerminologyProvider.manage` (packages/core/terminology), backed by real
 * FHIR `CodeSystem`/`ValueSet` resources on the same HAPI server external
 * terminologies live on (see the plan's "Recherche-Korrektur: Hades"
 * section for why one server for both was the deliberate choice).
 *
 * Modeling decisions, all standards-native rather than invented:
 * - Lifecycle (`draft`/`published`/`retired`) maps directly onto FHIR's own
 *   `CodeSystem.status`/`ValueSet.status` (`draft`/`active`/`retired`) - no
 *   custom extension needed.
 * - A business version bump mints a NEW HAPI resource id
 *   (`{terminologyId}-v{n}`) sharing the same canonical `url` but a
 *   different `version` - this is exactly HAPI's own documented multi-
 *   version-per-canonical-URL terminology support, not a workaround.
 * - Optimistic locking is a real HTTP `If-Match`/412 precondition (see
 *   `fhirClient.ts`'s `put()`), not a manually-compared field.
 * - `active`/inactive concepts use FHIR's own conventional `inactive`
 *   CodeSystem.concept property (the same one SNOMED CT's FHIR
 *   representation uses), not a bespoke shape.
 *
 * `content` is always `'not-present'`, never `'complete'` - found live
 * (2026-09-04) against a real HAPI 8.8.0 instance: a `content: 'complete'`
 * CodeSystem's *first* concept-adding PUT after its (concept-less) creation
 * PUT reliably fails with a Postgres unique-constraint violation on HAPI's
 * own internal `trm_codesystem_ver` bookkeeping table (confirmed
 * reproducible on a freshly created resource, not just this app's own
 * state - a real HAPI storage-engine bug in this version, not a config
 * mistake). `content: 'not-present'` sidesteps that code path entirely and
 * tolerates repeated PUTs cleanly (also confirmed live). Concept mutations
 * therefore do double duty: the PUT updates this resource's own
 * `concept[]` (the source of truth `listConcepts` reads back - reliable
 * regardless of HAPI's own $expand/search health), and a best-effort
 * `$apply-codesystem-delta-add`/`-remove` call keeps HAPI's *own*
 * search/expand index in sync for `search()`/`lookup()`/`validate()` -
 * HAPI's own documented, purpose-built mechanism for incrementally
 * maintaining a live CodeSystem's index without a full re-upload.
 */
import type { CustomTerminologySummary, TerminologyConcept } from 'core';
import { FhirClient, HapiRevisionConflictError, type FhirBundle, type FhirResource } from './fhirClient';

const TAG_SYSTEM = 'urn:formbuilder:tag';
const TAG_CUSTOM_TERMINOLOGY = 'custom-terminology';
const FAMILY_TAG_SYSTEM = 'urn:formbuilder:terminology-id';

interface CodeSystemConceptProperty { code: string; valueBoolean?: boolean; valueString?: string; }
interface CodeSystemConcept { code: string; display?: string; definition?: string; property?: CodeSystemConceptProperty[]; }
interface CustomCodeSystem extends FhirResource {
  name?: string;
  title?: string;
  concept?: CodeSystemConcept[];
}

/** `status` per `code` - lets terminologyRoutes.ts's `isTerminologyManageError()`
 * handling (packages/core/terminology) map straight to the right HTTP status
 * without needing to know this plugin's own code strings. `'invalid-id'` and
 * `'no-draft'` are caller-input mistakes (400); `'not-found'`/`'already-exists'`
 * are normal 404/409 outcomes; everything else here is this plugin's own PUT
 * to the upstream HAPI server itself coming back >=400, which is a 502
 * (bad gateway to the terminology server), not a 500 - this app's own error
 * handler is fine, it's HAPI that rejected the request. */
const MANAGE_ERROR_STATUS: Record<string, number> = {
  'invalid-id': 400,
  'no-draft': 400,
  'not-found': 404,
  'already-exists': 409,
};

export class ManageError extends Error {
  readonly status: number;
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ManageError';
    this.status = MANAGE_ERROR_STATUS[code] ?? 502;
  }
}

export function slugify(id: string): string {
  const slug = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new ManageError('Terminology id must contain at least one alphanumeric character', 'invalid-id');
  return slug;
}

export function namespaceFor(canonicalBase: string, terminologyId: string): string {
  return canonicalBase.startsWith('urn:') ? `${canonicalBase}:codesystem:${terminologyId}` : `${canonicalBase}/CodeSystem/${terminologyId}`;
}
export function bindingIdFor(canonicalBase: string, terminologyId: string): string {
  return canonicalBase.startsWith('urn:') ? `${canonicalBase}:valueset:${terminologyId}` : `${canonicalBase}/ValueSet/${terminologyId}`;
}
export function resourceIdFor(terminologyId: string, version: number): string {
  return `${terminologyId}-v${version}`;
}
function tags(terminologyId: string): Array<{ system: string; code: string }> {
  return [{ system: TAG_SYSTEM, code: TAG_CUSTOM_TERMINOLOGY }, { system: FAMILY_TAG_SYSTEM, code: terminologyId }];
}
export function statusToLifecycle(status: string | undefined): 'draft' | 'published' | 'retired' {
  if (status === 'active') return 'published';
  if (status === 'retired') return 'retired';
  return 'draft';
}
export function isActiveConcept(concept: CodeSystemConcept): boolean {
  return concept.property?.find((property) => property.code === 'inactive')?.valueBoolean !== true;
}

/** `$apply-codesystem-delta-add`/`-remove` - HAPI's own documented
 * operations for incrementally maintaining a live CodeSystem's
 * search/expand index (see this file's top-of-file doc comment). Both
 * require a `display` on every added concept or HAPI rejects the whole
 * call (a documented HAPI bug/limitation - see
 * https://github.com/hapifhir/hapi-fhir/issues/6159), hence the fallback to
 * the code itself when a concept has none. */
async function deltaAdd(client: FhirClient, namespace: string, concepts: CodeSystemConcept[]): Promise<void> {
  if (concepts.length === 0) return;
  const response = await client.post(`/CodeSystem/$apply-codesystem-delta-add`, {
    resourceType: 'Parameters',
    parameter: [
      { name: 'system', valueUri: namespace },
      { name: 'codeSystem', resource: { resourceType: 'CodeSystem', concept: concepts.map((concept) => ({ code: concept.code, display: concept.display || concept.code })) } },
    ],
  });
  if (response.status >= 400) client.logDebug(`$apply-codesystem-delta-add failed (non-fatal - see this file's doc comment)`, { namespace, status: response.status });
}

async function deltaRemove(client: FhirClient, namespace: string, code: string): Promise<void> {
  const response = await client.post(`/CodeSystem/$apply-codesystem-delta-remove`, {
    resourceType: 'Parameters',
    parameter: [
      { name: 'system', valueUri: namespace },
      { name: 'codeSystem', resource: { resourceType: 'CodeSystem', concept: [{ code }] } },
    ],
  });
  if (response.status >= 400) client.logDebug(`$apply-codesystem-delta-remove failed (non-fatal - see this file's doc comment)`, { namespace, code, status: response.status });
}

async function findVersionsOf(client: FhirClient, terminologyId: string): Promise<CustomCodeSystem[]> {
  const response = await client.get<FhirBundle<CustomCodeSystem>>(`/CodeSystem?_tag=${encodeURIComponent(`${FAMILY_TAG_SYSTEM}|${terminologyId}`)}&_count=100&_sort=-version`);
  if (response.status >= 400) throw new ManageError(`Failed to look up terminology ${terminologyId}`, 'lookup-failed');
  return (response.body.entry || []).map((entry) => entry.resource);
}

/** The version a `manage.*` call operates on by default: the current draft
 * if one exists, otherwise the highest-versioned active one, otherwise (every
 * version retired) the highest-versioned retired one - for read-only
 * operations (`listConcepts`, building a summary).
 *
 * Every fallback tier sorts explicitly by version number rather than trusting
 * `versions`' input order - found live (2026-09-04): `listTerminologies()`'s
 * own `/CodeSystem?_tag=...` query has no `_sort`, unlike `findVersionsOf()`
 * (used by every other manage.* call), so the two call sites could return
 * `versions` in different orders. That only surfaced once every version of a
 * terminology was retired (the one case that reaches this function's last
 * fallback): the admin UI's sidebar (via listTerminologies) showed a
 * different "current" version - with its own, different concept count -
 * than the detail panel (via findVersionsOf), a real inconsistency a tester
 * would see side by side on screen. */
function currentVersion(versions: CustomCodeSystem[]): CustomCodeSystem | undefined {
  const draft = versions.find((version) => (version.status ?? 'draft') === 'draft');
  if (draft) return draft;
  const byVersionDesc = (list: CustomCodeSystem[]) => [...list].sort((a, b) => Number(b.version) - Number(a.version));
  const active = byVersionDesc(versions.filter((version) => version.status === 'active'))[0];
  if (active) return active;
  return byVersionDesc(versions)[0];
}

function summaryOf(canonicalBase: string, terminologyId: string, resource: CustomCodeSystem, conceptCount?: number): CustomTerminologySummary {
  return {
    terminologyId,
    bindingId: bindingIdFor(canonicalBase, terminologyId),
    bindingVersion: resource.version,
    label: resource.title || resource.name || terminologyId,
    namespace: namespaceFor(canonicalBase, terminologyId),
    status: statusToLifecycle(resource.status),
    conceptCount: conceptCount ?? resource.concept?.length ?? 0,
    // The resource's own meta.versionId - what a caller must echo back as
    // manage.upsertConcept/removeConcept's expectedRevision for their next
    // edit (see CustomTerminologySummary.revision's own doc comment).
    revision: resource.meta?.versionId || resource.version || '0',
  };
}

/**
 * `getClient` is a factory, called fresh at the top of every method here -
 * not a single client captured once. Found live (2026-09-04): the earlier
 * "capture one FhirClient at plugin-activation time" shape meant a later
 * change to the "HAPI FHIR Basis-URL" plugin setting would never take
 * effect for `manage.*` without a full plugin reload, unlike
 * search/lookup/validate/discover (index.ts already re-resolves settings
 * per call there).
 */
export function createManage(getClient: () => FhirClient, getCanonicalBase: () => string) {
  return {
    async listTerminologies(): Promise<CustomTerminologySummary[]> {
      const client = getClient();
      const canonicalBase = getCanonicalBase();
      const response = await client.get<FhirBundle<CustomCodeSystem>>(`/CodeSystem?_tag=${encodeURIComponent(`${TAG_SYSTEM}|${TAG_CUSTOM_TERMINOLOGY}`)}&_count=200`);
      if (response.status >= 400) throw new ManageError('Failed to list custom terminologies', 'list-failed');
      const byFamily = new Map<string, CustomCodeSystem[]>();
      for (const resource of response.body.entry || []) {
        const familyTag = resource.resource.meta?.tag?.find((tag) => tag.system === FAMILY_TAG_SYSTEM)?.code;
        if (!familyTag) continue;
        const bucket = byFamily.get(familyTag) || [];
        bucket.push(resource.resource);
        byFamily.set(familyTag, bucket);
      }
      return Array.from(byFamily.entries(), ([terminologyId, versions]) => {
        const current = currentVersion(versions);
        return current ? summaryOf(canonicalBase, terminologyId, current) : undefined;
      }).filter((summary): summary is CustomTerminologySummary => Boolean(summary));
    },

    async createTerminology(input: { id: string; label: string }): Promise<CustomTerminologySummary> {
      const client = getClient();
      const canonicalBase = getCanonicalBase();
      const terminologyId = slugify(input.id);
      const existing = await findVersionsOf(client, terminologyId);
      if (existing.length > 0) throw new ManageError(`Terminology "${terminologyId}" already exists`, 'already-exists');
      const resourceId = resourceIdFor(terminologyId, 1);
      const namespace = namespaceFor(canonicalBase, terminologyId);
      const bindingId = bindingIdFor(canonicalBase, terminologyId);
      const codeSystem: CustomCodeSystem = {
        resourceType: 'CodeSystem', id: resourceId, url: namespace, version: '1', name: terminologyId, title: input.label,
        status: 'draft', content: 'not-present', meta: { tag: tags(terminologyId) }, concept: [],
      };
      const csResponse = await client.put<CustomCodeSystem>(`/CodeSystem/${resourceId}`, codeSystem);
      if (csResponse.status >= 400) throw new ManageError(`Failed to create CodeSystem for "${terminologyId}"`, 'create-failed');
      const valueSet = {
        resourceType: 'ValueSet', id: resourceId, url: bindingId, version: '1', name: terminologyId, title: input.label,
        status: 'draft', meta: { tag: tags(terminologyId) }, compose: { include: [{ system: namespace }] },
      };
      const vsResponse = await client.put(`/ValueSet/${resourceId}`, valueSet);
      if (vsResponse.status >= 400) throw new ManageError(`Failed to create ValueSet for "${terminologyId}"`, 'create-failed');
      return summaryOf(canonicalBase, terminologyId, csResponse.body, 0);
    },

    async listConcepts(terminologyId: string): Promise<TerminologyConcept[]> {
      const client = getClient();
      const versions = await findVersionsOf(client, terminologyId);
      const current = currentVersion(versions);
      if (!current) throw new ManageError(`Unknown terminology "${terminologyId}"`, 'not-found');
      const namespace = current.url || '';
      return (current.concept || []).map((concept) => ({
        namespace, namespaceVersion: current.version, code: concept.code, display: concept.display,
        definition: concept.definition, active: isActiveConcept(concept),
      }));
    },

    /**
     * Resolves the mutable target for an edit: the current draft if one
     * exists, or - since a published/retired terminology has no mutable
     * version at all - implicitly opens a new draft (next version number,
     * concepts copied forward from the current version) first. Either way
     * returns the exact resource an edit must be PUT against, plus the
     * revision token that edit's `If-Match` must carry.
     */
    async resolveMutableDraft(terminologyId: string, expectedRevision: string): Promise<{ resource: CustomCodeSystem; ifMatch: string }> {
      const client = getClient();
      const canonicalBase = getCanonicalBase();
      const versions = await findVersionsOf(client, terminologyId);
      const current = currentVersion(versions);
      if (!current) throw new ManageError(`Unknown terminology "${terminologyId}"`, 'not-found');
      if (statusToLifecycle(current.status) === 'draft') {
        if (current.meta?.versionId !== expectedRevision) throw new HapiRevisionConflictError(`Terminology "${terminologyId}" was modified since this revision was read`);
        return { resource: current, ifMatch: expectedRevision };
      }
      // No draft exists - the caller's expectedRevision must match the
      // current published/retired version (proves their view was current
      // before this implicitly opens a new draft on top of it).
      if (current.meta?.versionId !== expectedRevision) throw new HapiRevisionConflictError(`Terminology "${terminologyId}" was modified since this revision was read`);
      const nextVersion = Math.max(...versions.map((version) => Number(version.version) || 0)) + 1;
      const resourceId = resourceIdFor(terminologyId, nextVersion);
      const draft: CustomCodeSystem = {
        resourceType: 'CodeSystem', id: resourceId, url: current.url, version: String(nextVersion),
        name: current.name, title: current.title, status: 'draft', content: 'not-present',
        meta: { tag: tags(terminologyId) }, concept: current.concept ? [...current.concept] : [],
      };
      const response = await client.put<CustomCodeSystem>(`/CodeSystem/${resourceId}`, draft);
      if (response.status >= 400) throw new ManageError(`Failed to open a new draft version of "${terminologyId}"`, 'create-failed');
      const bindingId = bindingIdFor(canonicalBase, terminologyId);
      await client.put(`/ValueSet/${resourceId}`, {
        resourceType: 'ValueSet', id: resourceId, url: bindingId, version: String(nextVersion),
        name: current.name, title: current.title, status: 'draft', meta: { tag: tags(terminologyId) },
        compose: { include: [{ system: current.url }] },
      });
      // Re-seed HAPI's own search/expand index for the new version's
      // resource id - the new draft's concepts were copied into its
      // concept[] above (this app's own source of truth), but HAPI's index
      // is keyed per resource id/version and starts empty for a brand new
      // one; delta-add brings it back in sync. Best-effort - see this
      // file's own top-of-file doc comment for why a failure here must
      // never block the actual edit.
      if (draft.concept && draft.concept.length > 0) {
        await deltaAdd(client, current.url || '', draft.concept).catch(() => undefined);
      }
      return { resource: response.body, ifMatch: response.body.meta?.versionId || response.etag || String(nextVersion) };
    },

    async upsertConcept(terminologyId: string, concept: TerminologyConcept, expectedRevision: string): Promise<{ revision: string }> {
      const client = getClient();
      const { resource, ifMatch } = await this.resolveMutableDraft(terminologyId, expectedRevision);
      const nextConcept: CodeSystemConcept = {
        code: concept.code, display: concept.display, definition: concept.definition,
        ...(concept.active === false ? { property: [{ code: 'inactive', valueBoolean: true }] } : {}),
      };
      const nextConcepts = [...(resource.concept || []).filter((existing) => existing.code !== concept.code), nextConcept];
      const response = await client.put<CustomCodeSystem>(`/CodeSystem/${resource.id}`, { ...resource, concept: nextConcepts }, ifMatch);
      if (response.status >= 400) throw new ManageError(`Failed to save concept "${concept.code}" on "${terminologyId}"`, 'save-failed');
      await deltaAdd(client, resource.url || '', [nextConcept]).catch(() => undefined);
      return { revision: response.body.meta?.versionId || response.etag || ifMatch };
    },

    async removeConcept(terminologyId: string, code: string, expectedRevision: string): Promise<{ revision: string }> {
      const client = getClient();
      const { resource, ifMatch } = await this.resolveMutableDraft(terminologyId, expectedRevision);
      const nextConcepts = (resource.concept || []).filter((existing) => existing.code !== code);
      const response = await client.put<CustomCodeSystem>(`/CodeSystem/${resource.id}`, { ...resource, concept: nextConcepts }, ifMatch);
      if (response.status >= 400) throw new ManageError(`Failed to remove concept "${code}" from "${terminologyId}"`, 'save-failed');
      await deltaRemove(client, resource.url || '', code).catch(() => undefined);
      return { revision: response.body.meta?.versionId || response.etag || ifMatch };
    },

    async publishVersion(terminologyId: string): Promise<CustomTerminologySummary> {
      const client = getClient();
      const canonicalBase = getCanonicalBase();
      const versions = await findVersionsOf(client, terminologyId);
      const draft = versions.find((version) => statusToLifecycle(version.status) === 'draft');
      if (!draft) throw new ManageError(`Terminology "${terminologyId}" has no draft version to publish`, 'no-draft');
      const published = await client.put<CustomCodeSystem>(`/CodeSystem/${draft.id}`, { ...draft, status: 'active' }, draft.meta?.versionId);
      if (published.status >= 400) throw new ManageError(`Failed to publish "${terminologyId}"`, 'publish-failed');
      await client.put(`/ValueSet/${draft.id}`, { resourceType: 'ValueSet', id: draft.id, url: bindingIdFor(canonicalBase, terminologyId), version: draft.version, name: draft.name, title: draft.title, status: 'active', meta: { tag: tags(terminologyId) }, compose: { include: [{ system: draft.url }] } });
      return summaryOf(canonicalBase, terminologyId, published.body);
    },

    async retireVersion(terminologyId: string, version: string): Promise<CustomTerminologySummary> {
      const client = getClient();
      const canonicalBase = getCanonicalBase();
      const versions = await findVersionsOf(client, terminologyId);
      const target = versions.find((candidate) => candidate.version === version);
      if (!target) throw new ManageError(`Terminology "${terminologyId}" has no version "${version}"`, 'not-found');
      const retired = await client.put<CustomCodeSystem>(`/CodeSystem/${target.id}`, { ...target, status: 'retired' }, target.meta?.versionId);
      if (retired.status >= 400) throw new ManageError(`Failed to retire "${terminologyId}" v${version}`, 'retire-failed');
      await client.put(`/ValueSet/${target.id}`, { resourceType: 'ValueSet', id: target.id, url: bindingIdFor(canonicalBase, terminologyId), version: target.version, name: target.name, title: target.title, status: 'retired', meta: { tag: tags(terminologyId) }, compose: { include: [{ system: target.url }] } });
      const remaining = await findVersionsOf(client, terminologyId);
      const current = currentVersion(remaining) || retired.body;
      return summaryOf(canonicalBase, terminologyId, current);
    },
  };
}
