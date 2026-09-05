/**
 * Thin HAPI FHIR HTTP client - every FHIR-specific detail (operation
 * parameter shapes, ETag/If-Match handling, error classification) lives in
 * this plugin, never leaking into Core, `apps/api`'s generic terminology
 * routes, or FormRuntime.tsx. See this package's `index.ts` for how the
 * base URL is resolved from plugin settings.
 */
import axios, { type AxiosInstance, isAxiosError } from 'axios';
import type { PluginLogger } from 'plugin-api';

export interface FhirParameter {
  name: string;
  valueString?: string;
  valueBoolean?: boolean;
  valueCode?: string;
  valueUri?: string;
  valueInteger?: number;
  part?: FhirParameter[];
}

export interface FhirParameters {
  resourceType: 'Parameters';
  parameter?: FhirParameter[];
}

export interface FhirResource {
  resourceType: string;
  id?: string;
  url?: string;
  version?: string;
  status?: 'draft' | 'active' | 'retired' | 'unknown';
  meta?: { versionId?: string; tag?: Array<{ system?: string; code?: string }> };
  [key: string]: unknown;
}

export interface FhirBundle<T = FhirResource> {
  resourceType: 'Bundle';
  entry?: Array<{ resource: T }>;
}

/** Distinguishes a genuinely unreachable server (network/timeout/refused)
 * from an HTTP-level error the server itself returned (4xx/5xx with a
 * body) - see TerminologyValidationOutcome's own doc comment for why this
 * distinction matters end to end. */
export class HapiUnreachableError extends Error {
  constructor(message: string) { super(message); this.name = 'HapiUnreachableError'; }
}

/** A response HAPI itself returned that this client couldn't make sense of
 * as a success - carries the raw status/body so a caller can inspect an
 * OperationOutcome for a more specific classification (see
 * classifyValidateFailure in terminologyProvider.ts). */
export class HapiResponseError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: unknown) {
    super(message);
    this.name = 'HapiResponseError';
  }
}

/** A stale `expectedRevision` (If-Match precondition failed, HTTP 412) -
 * the one error `manage.upsertConcept`/`removeConcept` callers are expected
 * to specifically catch and surface as "someone else already changed this".
 * `code`/`status` - found live (2026-09-05): without these, this error had
 * no way to satisfy `core`'s `isTerminologyManageError()` duck-typing check,
 * so a genuine, well-messaged concurrent-edit conflict fell through
 * terminologyRoutes.ts as an unrecognized exception and surfaced to the
 * client as a generic 500 "Unexpected server error" instead of this
 * message with a proper 409. */
export class HapiRevisionConflictError extends Error {
  readonly code = 'revision-conflict';
  readonly status = 409;
  constructor(message: string) { super(message); this.name = 'HapiRevisionConflictError'; }
}

export class FhirClient {
  private readonly http: AxiosInstance;

  constructor(
    private readonly baseUrl: string,
    private readonly logger: PluginLogger,
  ) {
    this.http = axios.create({
      baseURL: baseUrl.replace(/\/$/, ''),
      timeout: 10_000,
      headers: {
        'content-type': 'application/fhir+json',
        accept: 'application/fhir+json',
        // HAPI caches GET search results for 60s by default ("Server
        // configured to cache search results for 60000 milliseconds", seen
        // live in its own startup log) - found live (2026-09-04): the
        // manage.ts existence-check search in createTerminology() and the
        // immediately-following listConcepts() search (same _tag query)
        // landed inside that window, so the second one served the first
        // one's now-stale empty result instead of re-querying. Cache-
        // Control: no-cache is HAPI's own documented way to bypass this per
        // request - required on every GET here, not just the ones that
        // "look" cache-sensitive, since any manage.* read can follow a
        // manage.* write within the same request chain.
        'cache-control': 'no-cache',
      },
      validateStatus: () => true, // handled manually below - a 4xx/5xx FHIR OperationOutcome is still a meaningful response, not a thrown axios error.
    });
  }

  private handleTransportError(error: unknown, describe: string): never {
    if (isAxiosError(error) && !error.response) {
      this.logger.warn(`[hapi-terminology] ${describe} unreachable`, { message: error.message });
      throw new HapiUnreachableError(`${describe}: ${error.message}`);
    }
    throw error;
  }

  async get<T = unknown>(path: string): Promise<{ status: number; body: T; etag?: string }> {
    try {
      const response = await this.http.get(path);
      return { status: response.status, body: response.data, etag: response.headers?.etag };
    } catch (error) {
      this.handleTransportError(error, `GET ${path}`);
    }
  }

  async post<T = unknown>(path: string, body: unknown): Promise<{ status: number; body: T; etag?: string }> {
    try {
      const response = await this.http.post(path, body);
      return { status: response.status, body: response.data, etag: response.headers?.etag };
    } catch (error) {
      this.handleTransportError(error, `POST ${path}`);
    }
  }

  /**
   * PUT with an optional `ifMatch` (the resource's last-known
   * `meta.versionId`) - HAPI rejects with 412 when the resource has moved
   * on since, which this normalizes into `HapiRevisionConflictError`. This
   * IS the optimistic-locking mechanism `manage.upsertConcept`/
   * `removeConcept` rely on (see TerminologyProvider.manage's own doc
   * comment) - not a manual versionId comparison, the real HTTP
   * precondition.
   */
  async put<T = unknown>(path: string, body: unknown, ifMatch?: string): Promise<{ status: number; body: T; etag?: string }> {
    try {
      const response = await this.http.put(path, body, ifMatch ? { headers: { 'If-Match': `W/"${ifMatch}"` } } : undefined);
      if (response.status === 412) {
        throw new HapiRevisionConflictError(`${path} was modified by someone else since this revision was read - reload and retry`);
      }
      return { status: response.status, body: response.data, etag: response.headers?.etag };
    } catch (error) {
      if (error instanceof HapiRevisionConflictError) throw error;
      this.handleTransportError(error, `PUT ${path}`);
    }
  }

  logDebug(message: string, details?: Record<string, unknown>): void {
    this.logger.debug(`[hapi-terminology] ${message}`, details);
  }
}

export function findParam(params: FhirParameters | undefined, name: string): FhirParameter | undefined {
  return params?.parameter?.find((param) => param.name === name);
}

export function paramString(params: FhirParameters | undefined, name: string): string | undefined {
  const param = findParam(params, name);
  return param?.valueString ?? param?.valueCode ?? param?.valueUri;
}

export function paramBoolean(params: FhirParameters | undefined, name: string): boolean | undefined {
  return findParam(params, name)?.valueBoolean;
}
