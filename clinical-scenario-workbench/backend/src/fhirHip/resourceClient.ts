import type { FormbuilderApiClient } from '../apiClient';

/**
 * Thin wrapper over the EXISTING, already-generic FHIR CDR admin routes
 * apps/api exposes (apps/api/src/services/fhirCdrService.ts, apps/api/src/
 * routes/ehrbaseAdminRoutes.ts) - this workbench never talks to the HIP's
 * FHIR API directly and never re-implements auth/connection handling. The
 * validation/gating this spec requires (Resource Form + Blueprint checks
 * before a write ever happens) lives one layer up, in agent/planner.ts -
 * this class is intentionally as dumb as create_fhir_resource/
 * get_fhir_resource/search_fhir_resource/update_fhir_resource already are.
 */
export class FhirHipClient {
  constructor(private readonly api: FormbuilderApiClient) {}

  create<T = any>(resourceType: string, resource: Record<string, unknown>): Promise<T> {
    return this.api.post<T>(`/api/admin/ehrbase/fhir-cdr/${encodeURIComponent(resourceType)}`, resource);
  }

  get<T = any>(resourceType: string, id: string): Promise<T> {
    return this.api.get<T>(`/api/admin/ehrbase/fhir-cdr/${encodeURIComponent(resourceType)}/${encodeURIComponent(id)}`);
  }

  search<T = any>(resourceType: string, query: Record<string, string> = {}): Promise<T> {
    const qs = Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
    return this.api.get<T>(`/api/admin/ehrbase/fhir-cdr/${encodeURIComponent(resourceType)}${qs}`);
  }

  update<T = any>(resourceType: string, id: string, resource: Record<string, unknown>): Promise<T> {
    return this.api.put<T>(`/api/admin/ehrbase/fhir-cdr/${encodeURIComponent(resourceType)}/${encodeURIComponent(id)}`, resource);
  }
}
