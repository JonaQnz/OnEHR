/**
 * search/lookup/validate/discover against a HAPI FHIR JPA terminology
 * server - the FHIR operations ($expand, $lookup, ValueSet/CodeSystem
 * $validate-code) and their differing parameter/version semantics are
 * entirely contained here, per the "Terminologie-Server-Integration" plan's
 * section F. `manage.ts` (custom-terminology CRUD/lifecycle) is a sibling
 * module, wired together in `index.ts`.
 */
import type {
  TerminologyBindingSummary,
  TerminologyConcept,
  TerminologyLookupInput,
  TerminologySearchInput,
  TerminologyValidateInput,
  TerminologyValidationOutcome,
} from 'core';
import {
  FhirClient,
  HapiResponseError,
  HapiUnreachableError,
  paramBoolean,
  paramString,
  type FhirBundle,
  type FhirParameters,
  type FhirResource,
} from './fhirClient';

interface ExpansionContains {
  system: string;
  version?: string;
  code: string;
  display?: string;
  inactive?: boolean;
}
interface ValueSetExpansionResource extends FhirResource {
  expansion?: { total?: number; contains?: ExpansionContains[] };
}

export function conceptFromExpansion(entry: ExpansionContains): TerminologyConcept {
  return {
    namespace: entry.system,
    namespaceVersion: entry.version,
    code: entry.code,
    display: entry.display,
    active: entry.inactive === true ? false : undefined,
  };
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

export async function search(client: FhirClient, input: TerminologySearchInput): Promise<TerminologyConcept[]> {
  const count = input.limit && input.limit > 0 ? Math.min(input.limit, 100) : 20;
  const activeOnly = input.activeOnly !== false;
  let response;
  if (input.bindingId) {
    const params = new URLSearchParams();
    params.set('url', input.bindingId);
    if (input.bindingVersion) params.set('valueSetVersion', input.bindingVersion);
    if (input.query) params.set('filter', input.query);
    params.set('count', String(count));
    params.set('activeOnly', String(activeOnly));
    response = await client.get<ValueSetExpansionResource>(`/ValueSet/$expand?${params.toString()}`);
  } else if (input.namespace) {
    // No curated binding known - build an ad-hoc ValueSet inline (this is
    // the one case FHIR genuinely requires a POST body for: there is no
    // GET-only way to expand "everything in this CodeSystem").
    const body = {
      resourceType: 'Parameters',
      parameter: [
        { name: 'valueSet', resource: { resourceType: 'ValueSet', status: 'active', compose: { include: [{ system: input.namespace, ...(input.namespaceVersion ? { version: input.namespaceVersion } : {}) }] } } },
        { name: 'filter', valueString: input.query },
        { name: 'count', valueInteger: count },
        { name: 'activeOnly', valueBoolean: activeOnly },
      ],
    };
    response = await client.post<ValueSetExpansionResource>('/ValueSet/$expand', body);
  } else {
    return [];
  }
  if (response.status >= 400) throw new HapiResponseError(`$expand failed with status ${response.status}`, response.status, response.body);
  return (response.body.expansion?.contains || []).map(conceptFromExpansion);
}

export async function lookup(client: FhirClient, input: TerminologyLookupInput): Promise<TerminologyConcept | undefined> {
  const params = new URLSearchParams();
  params.set('system', input.namespace);
  params.set('code', input.code);
  if (input.namespaceVersion) params.set('version', input.namespaceVersion);
  const response = await client.get<FhirParameters>(`/CodeSystem/$lookup?${params.toString()}`);
  if (response.status === 404) return undefined;
  if (response.status >= 400) throw new HapiResponseError(`$lookup failed with status ${response.status}`, response.status, response.body);
  const display = paramString(response.body, 'display');
  const definition = paramString(response.body, 'definition') || paramString(response.body, 'designation');
  return { namespace: input.namespace, namespaceVersion: input.namespaceVersion, code: input.code, display, definition };
}

/**
 * `$validate-code` returns HTTP 200 with `result: false` for the ordinary
 * "this code doesn't exist" case - that is NOT an HTTP error, and must not
 * be treated as one. Its accompanying `message`/`issues` text is the only
 * signal available to tell an outright-invalid code apart from "the
 * namespace/binding/version itself is unknown" - a best-effort classifier,
 * intentionally conservative (defaults to the common case, `invalid-code`,
 * for any message it doesn't recognize).
 */
export function classifyFailureMessage(message: string | undefined): TerminologyValidationOutcome {
  const text = (message || '').toLowerCase();
  if (/unknown code ?system|unrecognized code ?system|no code ?system/.test(text)) return { status: 'unknown-namespace' };
  if (/unable to find value ?set|unknown value ?set|no value ?set/.test(text)) return { status: 'unknown-binding' };
  if (/unknown version|no such version|version .* not found/.test(text)) return { status: 'unknown-version' };
  return { status: 'invalid-code' };
}

export async function validate(client: FhirClient, input: TerminologyValidateInput): Promise<TerminologyValidationOutcome> {
  try {
    let response;
    if (input.bindingId) {
      const params = new URLSearchParams();
      params.set('url', input.bindingId);
      if (input.bindingVersion) params.set('valueSetVersion', input.bindingVersion);
      params.set('code', input.code);
      if (input.namespace) params.set('system', input.namespace);
      response = await client.get<FhirParameters>(`/ValueSet/$validate-code?${params.toString()}`);
    } else if (input.namespace) {
      const params = new URLSearchParams();
      params.set('url', input.namespace);
      if (input.namespaceVersion) params.set('version', input.namespaceVersion);
      params.set('code', input.code);
      response = await client.get<FhirParameters>(`/CodeSystem/$validate-code?${params.toString()}`);
    } else {
      return { status: 'provider-error', message: 'Neither a namespace nor a binding was configured for this field' };
    }
    if (response.status >= 400) {
      const outcomeMessage = extractOperationOutcomeMessage(response.body) || `HTTP ${response.status}`;
      return classifyFailureMessage(outcomeMessage);
    }
    const result = paramBoolean(response.body, 'result');
    const message = paramString(response.body, 'message');
    if (result === true) {
      const display = paramString(response.body, 'display');
      return { status: 'valid', concept: { namespace: input.namespace || input.bindingId || '', namespaceVersion: input.namespaceVersion, code: input.code, display } };
    }
    return classifyFailureMessage(message);
  } catch (error) {
    if (error instanceof HapiUnreachableError) return { status: 'unreachable', message: error.message };
    if (error instanceof HapiResponseError) return classifyFailureMessage(extractOperationOutcomeMessage(error.body));
    return { status: 'provider-error', message: error instanceof Error ? error.message : String(error) };
  }
}

export function extractOperationOutcomeMessage(body: unknown): string | undefined {
  const outcome = body as { issue?: Array<{ diagnostics?: string; details?: { text?: string } }> } | undefined;
  const issue = outcome?.issue?.[0];
  return issue?.diagnostics || issue?.details?.text;
}

export function bindingSummaryFromValueSet(resource: FhirResource & { title?: string; name?: string }): TerminologyBindingSummary {
  const compose = (resource as { compose?: { include?: Array<{ system?: string }> } }).compose;
  return {
    bindingId: resource.url || resource.id || '',
    label: resource.title || resource.name || resource.id || resource.url || 'Unnamed',
    namespace: compose?.include?.[0]?.system,
    bindingVersion: resource.version,
  };
}

export async function searchBindings(client: FhirClient, query: string): Promise<TerminologyBindingSummary[]> {
  const params = new URLSearchParams();
  if (query) params.set('_content', query);
  params.set('_count', '20');
  const response = await client.get<FhirBundle>(`/ValueSet?${params.toString()}`);
  if (response.status >= 400) throw new HapiResponseError(`ValueSet search failed with status ${response.status}`, response.status, response.body);
  return (response.body.entry || []).map((entry) => bindingSummaryFromValueSet(entry.resource));
}

export async function getBinding(client: FhirClient, bindingId: string, bindingVersion?: string): Promise<TerminologyBindingSummary | undefined> {
  const params = new URLSearchParams();
  params.set('url', bindingId);
  if (bindingVersion) params.set('version', bindingVersion);
  params.set('_count', '1');
  const response = await client.get<FhirBundle>(`/ValueSet?${params.toString()}`);
  if (response.status >= 400) throw new HapiResponseError(`ValueSet lookup failed with status ${response.status}`, response.status, response.body);
  const resource = response.body.entry?.[0]?.resource;
  return resource ? bindingSummaryFromValueSet(resource) : undefined;
}

export { encode };
