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
