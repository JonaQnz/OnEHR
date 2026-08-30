import type { FormRuntimeMode, FormSession, FormSessionValues } from '../form-session';

/** Stable contract for hosts that launch a WatEHR form. */
export const FORM_LAUNCH_PROTOCOL_VERSION = 'watehr.form-launch.v1' as const;

export type FormLaunchLoadPolicy = 'never' | 'provider';

export interface FormLaunchPatient {
  id: string;
  namespace?: string;
}

export interface FormLaunchRequest {
  protocolVersion?: typeof FORM_LAUNCH_PROTOCOL_VERSION;
  formId: string;
  patient: FormLaunchPatient;
  mode?: FormRuntimeMode;
  /** Values supplied by the host. They override provider-loaded values. */
  initialValues?: FormSessionValues;
  /** Use only for an explicit openEHR composition version/reference. */
  providerReference?: string;
  /** Lets a host opt into loading existing provider data before opening. */
  load?: FormLaunchLoadPolicy;
  /** Skips reusing this user's own still-open edit/prefill session for the
   * same form+patient(+composition) and always starts a fresh one. Default
   * false - repeated launches resume the existing attempt instead of
   * spawning a disconnected duplicate. Has no effect in create/view mode. */
  forceNew?: boolean;
  /** Opaque host correlation value, returned in browser events but never persisted as clinical data. */
  launchId?: string;
  encounterId?: string;
  /** Optional non-required fields hidden by a trusted Composition host. */
  hiddenFieldIds?: string[];
  /** Per-instance display-label override, keyed by field id. Cosmetic only -
   * never changes the referenced Form Section's own canonical label. */
  fieldLabelOverrides?: Record<string, string>;
  /** Required when formId names a bare Form Section (kind "form", no
   * `watehr.composition` extension) - a Form Section can never be launched
   * standalone for a patient, only as a block already wired into a running
   * Composition session. The server independently verifies this block
   * really exists on the referenced Composition session and really maps to
   * this formId before allowing the launch; it is not a client-trusted
   * flag. Omit entirely when formId is itself a Form/Composition. */
  compositionContext?: {
    compositionSessionId: string;
    blockId: string;
  };
}

export interface FormLaunchResult {
  protocolVersion: typeof FORM_LAUNCH_PROTOCOL_VERSION;
  session: FormSession;
  launchUrl: string;
}

export type FormEmbedEventName = 'loaded' | 'submitted' | 'error' | 'resize' | 'dirty';

export interface FormEmbedEvent {
  protocolVersion: typeof FORM_LAUNCH_PROTOCOL_VERSION;
  event: FormEmbedEventName;
  formId: string;
  sessionId?: string;
  launchId?: string;
  message?: string;
  height?: number;
  /** Only meaningful on the 'dirty' event - whether the embedded session
   * currently has unsaved changes, for a host (e.g. CompositionRuntime) to
   * aggregate its own navigation guard across several embedded forms. */
  dirty?: boolean;
}
