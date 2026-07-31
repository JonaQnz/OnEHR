import prisma from '../db/prisma';
import {
  FORM_LAUNCH_PROTOCOL_VERSION,
  isFormRuntimeMode,
  type FormLaunchRequest,
  type FormLaunchResult,
  type FormSessionValues,
} from 'core';
import { HttpError } from '../middleware/errorHandler';
import {
  createFormSession,
  loadFormSessionFromProvider,
  patchFormSession,
  type SessionActor,
} from './formSessionService';

function nonEmptyText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} is required`);
  return value.trim();
}

function objectValues(value: unknown): FormSessionValues {
  if (!value) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'initialValues must be an object');
  return value as FormSessionValues;
}

/**
 * Creates an authorized, single-session launch. The browser receives only the
 * session id in its URL; patient identity and initial data remain server-side.
 */
export async function launchForm(input: FormLaunchRequest, actor: SessionActor): Promise<FormLaunchResult> {
  if (input.protocolVersion && input.protocolVersion !== FORM_LAUNCH_PROTOCOL_VERSION) {
    throw new HttpError(400, `Unsupported form launch protocol: ${input.protocolVersion}`);
  }
  const formId = nonEmptyText(input.formId, 'formId');
  const patientId = nonEmptyText(input.patient?.id, 'patient.id');
  const mode = input.mode || 'create';
  if (!isFormRuntimeMode(mode)) throw new HttpError(400, 'mode must be create, edit, view, or prefill');
  const load = input.load || 'never';
  if (load !== 'never' && load !== 'provider') throw new HttpError(400, 'load must be never or provider');

  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) throw new HttpError(404, 'Form not found');
  if (form.status !== 'published') throw new HttpError(409, 'Only published forms can be launched through the integration API');

  const initialValues = objectValues(input.initialValues);
  let session = await createFormSession({
    formId,
    patientId,
    ...(input.patient.namespace ? { patientNamespace: input.patient.namespace } : {}),
    mode,
    values: load === 'never' ? initialValues : {},
    ...(input.providerReference ? { providerReference: nonEmptyText(input.providerReference, 'providerReference') } : {}),
  }, actor);

  if (load === 'provider') {
    const providerId = (form.canonical_json as { settings?: { submission?: { providerId?: unknown } } })
      .settings?.submission?.providerId;
    const loaded = await loadFormSessionFromProvider(session.id, typeof providerId === 'string' ? providerId : 'ehrbase', actor);
    session = loaded.session;
    // Host values intentionally win over provider values, e.g. encounter-local
    // defaults supplied by a KIS.
    if (Object.keys(initialValues).length > 0) {
      session = await patchFormSession(session.id, {
        values: { ...session.values, ...initialValues },
        expectedRevision: session.revision,
      }, actor);
    }
  }

  const query = new URLSearchParams({ sessionId: session.id });
  if (input.encounterId) query.set('encounterId', nonEmptyText(input.encounterId, 'encounterId'));
  if (input.launchId) query.set('launchId', nonEmptyText(input.launchId, 'launchId'));
  return {
    protocolVersion: FORM_LAUNCH_PROTOCOL_VERSION,
    session,
    launchUrl: `/embed/forms/${encodeURIComponent(formId)}?${query.toString()}`,
  };
}
