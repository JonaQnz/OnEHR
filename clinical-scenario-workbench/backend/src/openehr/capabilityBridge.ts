import type { FormbuilderApiClient } from '../apiClient';
import type { ActivityLog } from '../activity/log';
import type { CapabilityRegistry } from '../capability/registry';

/**
 * Bridges a scenario's openEHR clinical capabilities onto the EXISTING
 * Form Builder Composition-session runtime - never a second write path.
 * This calls the exact same apps/api HTTP routes the main repo's own
 * packages/mcp-server/src/tools/runtimeTools.ts wraps
 * (start_composition_session/create_form_session/attach_composition_block/
 * submit_form_session_to_provider) - copied here as plain HTTP calls (not
 * imported - this project stays decoupled from the main repo's workspace
 * graph, see README.md) rather than spawning that MCP server as a
 * subprocess, since this backend already holds its own authenticated
 * FormbuilderApiClient.
 *
 * A Form Section can never be launched standalone for a patient (spec/
 * CLAUDE.md's Form Section vs Form distinction) - it always fills one block
 * of an already-published Composition-kind Form. This workbench does NOT
 * author new Compositions for the LAE scenario's two known openEHR
 * capabilities: "Anamnese" (id 94fba4cc-a179-4780-94f9-1cc9dba42f0a, block
 * "block-diagnosis-1" -> the "Kodierte Diagnose" Form Section) and
 * "Vitalzeichen-Erfassung" (id b82c488f-688a-49d2-8031-447a0440d098, block
 * "vitals_block" -> the "Vitalzeichen" Form Section) already exist,
 * published, in this Forms instance and fit perfectly - reusing them is
 * exactly the "existing Form Builder infra" the spec insists on, and
 * satisfies the later steering requirement that every health record stay
 * viewable through the real Form Builder UI (they're ordinary Compositions,
 * visible via the normal Composition/Patient views, not a workbench-only
 * artifact).
 */
export interface OpenEhrCapabilityConfig {
  /** User's own architectural principle: the "Basis" forms (Diagnose/
   * Prozedur/Medikation/Laborwert/Anordnung (Basis) - already FHIR-mapped,
   * one atomic clinical fact each) are the canonical building blocks;
   * anything more specialized is a "composed" capability that conceptually
   * extends one. 'basis' when this capability's Form Section IS one of
   * those Basis forms; 'composed' otherwise. Purely descriptive metadata
   * for now (see `basedOn`) - a composed capability's own Form Section is
   * NOT required to literally embed its basis form's fields yet; that's a
   * real Form Builder redesign task, deliberately not done as a side effect
   * of this tagging. */
  role: 'basis' | 'composed';
  /** For a 'composed' capability, the basis capability name it conceptually
   * extends (e.g. "lab-result" -> basedOn: "lab-value"). Undefined for a
   * 'basis' capability itself. */
  basedOn?: string;
  /** Short human-readable description - shown by the `list_capabilities`
   * MCP tool (mcp/tools/capabilityTools.ts) so an agent can pick the right
   * capability by name without re-deriving what it does from its Form
   * ids. Optional: absent on most of this catalog's original hand-authored
   * entries, expected on anything registered via `register_capability`. */
  description?: string;
  /** The Composition-kind Form's id (a real, already-published Form in this
   * Forms instance - never authored by this workbench for a capability that
   * already has a fitting one). */
  compositionFormId: string;
  /** The block, within that Composition's own extensions["watehr.composition"]
   * page layout, this capability's Form Section fills. */
  blockId: string;
  /** The embedded Form Section's own id (create_form_session's `formId`). */
  formSectionFormId: string;
  /** true for a repeatable measurement (e.g. vital signs, one new
   * Composition per timepoint - matches "Vitalzeichen-Erfassung"'s own
   * storageStrategy: "always_new"); false for a one-time-per-encounter
   * capability (e.g. anamnesis) that should resume the same session on a
   * second call rather than creating a duplicate Composition. */
  forceNewComposition: boolean;
}

export interface OpenEhrCapabilityResult {
  compositionSessionId: string;
  formSessionId: string;
  /** The provider's own reference to the committed Composition (an EHRbase
   * versioned Composition uid), once submit succeeds. */
  providerReference?: string;
}

/**
 * Runs one openEHR capability's full runtime path against a patient: start/
 * resume the Composition session, create the embedded Form Section's own
 * session pre-filled with `values`, wire it into the composition's block,
 * then submit - which re-validates the CURRENT values server-side before
 * ever committing (per submit_form_session_to_provider's own documented
 * behavior), so a bad value throws here rather than silently landing in
 * EHRbase. No separate validate_form_session call is needed for that reason.
 */
export async function ensureOpenEhrCapability(
  api: FormbuilderApiClient,
  config: OpenEhrCapabilityConfig,
  patient: { id: string; namespace?: string },
  values: Record<string, unknown>,
): Promise<OpenEhrCapabilityResult> {
  const compositionSession = await api.post<{ id: string }>('/api/composition-sessions', {
    compositionFormId: config.compositionFormId,
    patientId: patient.id,
    patientNamespace: patient.namespace,
    mode: 'create',
    forceNew: config.forceNewComposition,
  });

  const formSession = await api.post<{ id: string }>('/api/form-sessions', {
    formId: config.formSectionFormId,
    patientId: patient.id,
    patientNamespace: patient.namespace,
    values,
    mode: 'create',
    compositionContext: { compositionSessionId: compositionSession.id, blockId: config.blockId },
  });

  await api.put(`/api/composition-sessions/${encodeURIComponent(compositionSession.id)}/blocks/${encodeURIComponent(config.blockId)}`, {
    childSessionId: formSession.id,
  });

  const submitted = await api.post<{ providerReference?: string }>(
    `/api/form-sessions/${encodeURIComponent(formSession.id)}/provider/submit`,
    {},
  );

  return { compositionSessionId: compositionSession.id, formSessionId: formSession.id, providerReference: submitted.providerReference };
}

/**
 * `ensureOpenEhrCapability` plus registering the result into the Capability
 * Registry (spec §23/§25) - what the frontend's ClinicWorld/PatientView
 * actually reads to know a capability exists and to re-embed it read-only
 * later (`components/OpenEhrEmbed.tsx`), and what's logged to Activity like
 * every other ensure* step in this workbench. Kept separate from the plain
 * `ensureOpenEhrCapability` above so a caller that only wants the runtime
 * side effect (no registry bookkeeping) still has that option.
 */
export async function ensureOpenEhrCapabilityAndRegister(
  deps: { api: FormbuilderApiClient; capabilities: CapabilityRegistry; activity: ActivityLog },
  capability: string,
  config: OpenEhrCapabilityConfig,
  patient: { id: string; namespace?: string },
  patientScenarioKey: string,
  values: Record<string, unknown>,
): Promise<OpenEhrCapabilityResult> {
  const reason = `openEHR capability "${capability}" required for scenario patient "${patientScenarioKey}"`;
  const action = `fill ${config.formSectionFormId} into ${config.compositionFormId}`;
  let result: OpenEhrCapabilityResult;
  try {
    result = await ensureOpenEhrCapability(deps.api, config, patient, values);
  } catch (error: any) {
    deps.activity.append({ reason, action, tool: 'ensure_capability', result: 'error', message: error?.message ?? String(error) });
    throw error;
  }
  deps.capabilities.upsert(capability, {
    kind: 'openEHR',
    formId: config.formSectionFormId,
    compositionFormId: config.compositionFormId,
    blockId: config.blockId,
    patientScenarioKey,
    compositionSessionId: result.compositionSessionId,
    formSessionId: result.formSessionId,
    providerReference: result.providerReference,
  });
  deps.activity.append({ reason, action, tool: 'ensure_capability', result: 'success', message: `Composition ${result.providerReference ?? result.compositionSessionId} submitted` });
  return result;
}

/**
 * The one place this workbench asks the Form Builder for a real, embeddable
 * "look at this Composition" page - a fresh VIEW-mode session that loads the
 * already-submitted data straight from EHRbase (`mode: 'view', load:
 * 'provider'`), per docs/integration/form-launch-v1.md's own `POST
 * /api/form-launches` contract (packages/mcp-server's `launch_form`/
 * apps/web's `launchEmbeddedForm` both call this same endpoint). Returns the
 * relative `launchUrl` (e.g. "/embed/forms/<id>?sessionId=<id>") - the
 * frontend turns it into an iframe src against `formbuilderWebUrl`, adding
 * `hostOrigin` the same way apps/web's own `formEmbedUrl` does. This never
 * reuses the original submission's formSessionId directly - view mode is a
 * fresh, read-only session every time, so re-opening a capability card can
 * never accidentally resume/edit a finished submission.
 */
export async function getViewEmbedUrl(
  api: FormbuilderApiClient,
  config: Pick<OpenEhrCapabilityConfig, 'formSectionFormId' | 'blockId'>,
  compositionSessionId: string,
  patient: { id: string; namespace?: string },
): Promise<string> {
  const launch = await api.post<{ launchUrl: string }>('/api/form-launches', {
    formId: config.formSectionFormId,
    patient: { id: patient.id, namespace: patient.namespace },
    mode: 'view',
    load: 'provider',
    compositionContext: { compositionSessionId, blockId: config.blockId },
  });
  return launch.launchUrl;
}
