import prisma from '../db/prisma';
import {
  isFormDataProviderError,
  type FormDataProviderContext,
  type FormDefinitionV1,
  type FormRuntimeMode,
  type FormSessionChangeType,
  type FormSessionLifecycleState,
} from 'core';
import { HttpError } from '../middleware/errorHandler';
import { persistedMode } from './formSessionLifecycle';
import { compositionUidFromReference } from './formIdentity';
import { getCompositionRepository } from './compositionRepository';
import { recordCompositionVersionEvent } from './compositionVersionEvents';
import { EhrbaseProviderError } from './ehrbaseDataProvider';
import { getDataProvider } from './dataProviderRegistry';
import type { FormSessionRow } from './formSessionRecord';

/**
 * The CDR side of a Form Session's lifecycle - pushing a running draft,
 * committing a final submission and withdrawing a finalized composition.
 * Split out of formSessionService (P2) so the provider boundary's own rules
 * (which reference a draft seeds from, which failures are surfaced vs. only
 * logged) live in one small module instead of inside the form API's own DB
 * orchestration. Behaviour is unchanged: this is a verbatim move.
 */

export function isVersionConflict(error: unknown): boolean {
  return error instanceof EhrbaseProviderError && error.code === 'COMPOSITION_VERSION_CONFLICT';
}

/** Any `FormDataProvider`'s own error translates the same way, whether it's
 * a built-in provider (EHRbase) or one supplied by a plugin (n8n, or any
 * future workflow-engine plugin) - detected structurally via
 * `isFormDataProviderError()`, never by importing a specific provider's
 * error class. A plugin-supplied provider living in its own package is
 * never a compile-time dependency of this file. */
export function mapProviderError(error: unknown): never {
  if (isFormDataProviderError(error)) {
    const status = typeof error.status === 'number' && error.status >= 400 && error.status < 600 ? error.status : 502;
    throw new HttpError(status, error.message, { code: error.code, messages: error.messages ? [...error.messages] : [{ severity: 'error', code: error.code, message: error.message }] });
  }
  throw error;
}

/**
 * Best-effort push of an already locally-saved draft to the session's data
 * provider. The local write is the caller's responsibility and always
 * happens first, so a transient provider failure here never loses what the
 * user just typed - the next debounced autosave retries. A version conflict
 * is the one exception: someone else's newer version already exists, so it
 * is surfaced via mapProviderError instead of silently swallowed.
 */
export async function pushDraftToProvider(args: {
  sessionId: string;
  mode: FormRuntimeMode;
  draftReference: string | null;
  providerReference: string | null;
  providerId: string;
  context: FormDataProviderContext;
  form: { id: string; version: string; definition: FormDefinitionV1 };
  provider: ReturnType<typeof getDataProvider>;
  values: Record<string, unknown>;
}): Promise<{ updated?: FormSessionRow; providerResult?: unknown }> {
  const repository = getCompositionRepository(args.providerId);
  let updated: FormSessionRow | undefined;
  let providerResult: unknown;
  if (repository) {
    // Continue this session's own prior draft if one exists. Otherwise, for
    // an edit-mode session, seed from providerReference (the composition
    // actually being edited) so autosave progressively updates that same
    // record instead of spawning a separate draft composition. A
    // create/prefill-mode session with no draft yet gets no seed - its
    // providerReference, if any, is a prefill *source* that must never be
    // silently overwritten by autosave.
    const seedReference = args.draftReference || (persistedMode(args.mode) === 'edit' ? args.providerReference : undefined) || undefined;
    try {
      const result = await repository.commit({
        context: args.context,
        form: args.form,
        values: args.values,
        ...(seedReference ? { reference: seedReference } : {}),
        desiredLifecycleState: 'incomplete',
      }, 'draft');
      providerResult = result;
      updated = await prisma.formSession.update({ where: { id: args.sessionId }, data: {
        providerId: result.providerId,
        draftReference: result.reference || seedReference || null,
        lifecycleState: result.lifecycleState,
        lifecycleConfirmed: result.lifecycleConfirmed,
      } });
      const eventEhrId = typeof result.metadata?.ehrId === 'string' ? result.metadata.ehrId : undefined;
      if (result.reference && eventEhrId) {
        void recordCompositionVersionEvent({
          versionUid: result.reference,
          compositionUid: compositionUidFromReference(result.reference) || result.reference,
          ehrId: eventEhrId,
          formSessionId: args.sessionId,
          lifecycleState: result.lifecycleState,
        });
      }
    } catch (error) {
      // A version conflict is never a transient provider hiccup - it means
      // someone else's newer version already exists, so silently degrading
      // here (as every other push failure does) would hide a real risk of
      // overwriting it. Surface it distinctly instead of swallowing it.
      if (isVersionConflict(error)) return mapProviderError(error);
      console.warn(`[formSessionCdrWriter] Draft autosave to provider '${args.providerId}' failed for session ${args.sessionId}; local draft was still saved:`, error instanceof Error ? error.message : error);
    }
  } else if (args.provider.capabilities.includes('draft') && args.provider.draft) {
    const seedReference = args.draftReference || (persistedMode(args.mode) === 'edit' ? args.providerReference : undefined) || undefined;
    try {
      const result = await args.provider.draft({
        context: args.context,
        form: args.form,
        values: args.values,
        ...(seedReference ? { reference: seedReference } : {}),
      });
      providerResult = result;
      updated = await prisma.formSession.update({ where: { id: args.sessionId }, data: {
        providerId: result.providerId,
        draftReference: result.reference || seedReference || null,
        // No lifecycle mechanism on this provider - Forms' own tracked
        // state still advances (there IS a real draft now), just never
        // CDR-confirmed.
        lifecycleState: 'incomplete',
        lifecycleConfirmed: false,
      } });
    } catch (error) {
      // A version conflict is never a transient provider hiccup - it means
      // someone else's newer version already exists, so silently degrading
      // here (as every other push failure does) would hide a real risk of
      // overwriting it. Surface it distinctly instead of swallowing it.
      if (isVersionConflict(error)) return mapProviderError(error);
      console.warn(`[formSessionCdrWriter] Draft autosave to provider '${args.providerId}' failed for session ${args.sessionId}; local draft was still saved:`, error instanceof Error ? error.message : error);
    }
  }
  return { updated, providerResult };
}

export interface ProviderCommitOutcome {
  providerId: string;
  reference?: string;
  metadata?: { ehrId?: string; templateId?: string };
  lifecycleState?: FormSessionLifecycleState;
  lifecycleConfirmed?: boolean;
}

/** Commit a session's final values to its data provider - the composition
 * repository first, else the provider's own submit. Any provider failure is
 * translated via mapProviderError, never left raw. */
export async function commitSubmission(args: {
  providerId: string;
  context: FormDataProviderContext;
  form: { id: string; version: string; definition: FormDefinitionV1 };
  provider: ReturnType<typeof getDataProvider>;
  values: Record<string, unknown>;
  submitReference?: string;
  continuesDraft: boolean;
  desiredChangeType?: FormSessionChangeType;
  changeDescription?: string;
}): Promise<ProviderCommitOutcome> {
  const repository = getCompositionRepository(args.providerId);
  try {
    if (repository) {
      return await repository.commit({
        context: args.context,
        form: args.form,
        values: args.values,
        ...(args.submitReference ? { reference: args.submitReference } : {}),
        continuesDraft: args.continuesDraft,
        desiredLifecycleState: 'complete',
        ...(args.desiredChangeType ? { desiredChangeType: args.desiredChangeType } : {}),
        ...(args.changeDescription ? { changeDescription: args.changeDescription } : {}),
      }, 'submit');
    }
    return await args.provider.submit({
      context: args.context,
      form: args.form,
      values: args.values,
      ...(args.submitReference ? { reference: args.submitReference } : {}),
      continuesDraft: args.continuesDraft,
    });
  } catch (error) {
    return mapProviderError(error);
  }
}

/** Logical withdrawal of a finalized composition. Only providers with a
 * composition repository can withdraw; an unknown one is a 501. */
export async function withdrawComposition(args: {
  providerId: string;
  context: FormDataProviderContext;
  reference: string;
  reason?: string;
}) {
  const repository = getCompositionRepository(args.providerId);
  if (!repository) throw new HttpError(501, `Provider '${args.providerId}' does not support withdrawing a composition`);
  try {
    return await repository.withdraw({ context: args.context, reference: args.reference, ...(args.reason ? { reason: args.reason } : {}) });
  } catch (error) {
    return mapProviderError(error);
  }
}
