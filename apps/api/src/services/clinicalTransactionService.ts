/**
 * Epic 4 - openEHR CONTRIBUTION support: application-level orchestration
 * for saving several child forms of a Composition session together as one
 * real openEHR CONTRIBUTION, instead of independent per-form submits.
 *
 * Reuses, rather than duplicates: composition-session validation
 * (validateCompositionSession), the canonical composition builder
 * (openehr-engine's buildCanonicalComposition - same one §1 introduced),
 * the CDR transport (ContributionRepository via getCompositionRepository),
 * and the "apply a successful commit result to a FormSession" step
 * (formSessionService.applySuccessfulProviderCommit - the same function
 * submitFormSessionToProvider's own single-form path now calls too, so
 * there is exactly one place that updates session state after a save).
 */
import prisma from '../db/prisma';
import { HttpError } from '../middleware/errorHandler';
import { getCompositionDefinition, migrateCanonicalFormToV1, type FormDataProviderContext } from 'core';
import { buildCanonicalComposition } from 'openehr-engine';
import { getCompositionSession, validateCompositionSession, type CompositionSessionActor } from './compositionSessionService';
import { getCompositionRepository } from './compositionRepository';
import { applySuccessfulProviderCommit } from './formSessionService';
import { getRemoteWebTemplate } from './ehrbaseService';
import { getConfig } from './configService';

export type ClinicalTransactionActor = CompositionSessionActor;

type OperationType = 'create' | 'modification' | 'amendment';

export interface PublicOperation {
  id: string;
  formSessionId: string;
  blockId?: string;
  type: OperationType;
  status: string;
  baseVersionUid?: string;
  resultVersionUid?: string;
  changeDescription?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface PublicClinicalTransaction {
  id: string;
  compositionSessionId: string;
  ehrId: string;
  status: string;
  description?: string;
  contributionUid?: string;
  /** Whether this commit actually landed as one real openEHR CONTRIBUTION
   * (true) or via the non-atomic sequential fallback (false) - absent until
   * a commit attempt has actually run. Never inferred from contributionUid
   * alone, so the UI can state plainly whether atomicity was achieved. */
  atomic?: boolean;
  operations: PublicOperation[];
  errorCode?: string;
  errorMessage?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} is required`);
  return value.trim();
}

function owner(record: { userId: string }, actor: ClinicalTransactionActor): void {
  if (record.userId !== actor.userId && actor.userId !== 'anonymous') throw new HttpError(403, 'You do not have access to this transaction');
}

function publicOperation(row: any): PublicOperation {
  return {
    id: row.id,
    formSessionId: row.formSessionId,
    ...(row.blockId ? { blockId: row.blockId } : {}),
    type: row.type,
    status: row.status,
    ...(row.baseVersionUid ? { baseVersionUid: row.baseVersionUid } : {}),
    ...(row.resultVersionUid ? { resultVersionUid: row.resultVersionUid } : {}),
    ...(row.changeDescription ? { changeDescription: row.changeDescription } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
  };
}

function publicTransaction(row: any, operations: any[]): PublicClinicalTransaction {
  return {
    id: row.id,
    compositionSessionId: row.compositionSessionId,
    ehrId: row.ehrId,
    status: row.status,
    ...(row.description ? { description: row.description } : {}),
    ...(row.contributionUid ? { contributionUid: row.contributionUid } : {}),
    ...(row.atomic !== null && row.atomic !== undefined ? { atomic: row.atomic } : {}),
    operations: operations.map(publicOperation),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadTransaction(id: string, actor: ClinicalTransactionActor) {
  const record = await prisma.clinicalTransaction.findUnique({ where: { id: text(id, 'id') } });
  if (!record) throw new HttpError(404, 'Clinical transaction not found');
  owner(record, actor);
  const operations = await prisma.clinicalTransactionOperation.findMany({ where: { transactionId: record.id }, orderBy: { createdAt: 'asc' } });
  return { record, operations };
}

/** The resolved reference a FormSession currently points at - its own
 * running draft if it has one, else its last submitted composition. Same
 * precedence submitFormSessionToProvider itself uses for "what does this
 * session's provider state currently target". */
function currentReference(session: { draftReference: string | null; providerReference: string | null }): string | undefined {
  return session.draftReference || session.providerReference || undefined;
}

// ClinicalTransactionOperationType uses 'create' (this app's own
// vocabulary, matching the Prisma enum); ContributionRepository speaks the
// real openEHR term 'creation' - map at this one boundary rather than
// renaming either side to match the other.
function toDesiredChangeType(type: OperationType): 'creation' | 'modification' | 'amendment' {
  return type === 'create' ? 'creation' : type;
}

/**
 * Validates every attached child form (reusing validateCompositionSession
 * unchanged) and, if all are valid, prepares (or, given a repeated
 * clientRequestId, returns the existing) ClinicalTransaction row - one
 * operation per attached child, typed create/modification from each
 * child's own current lifecycle state exactly like
 * submitFormSessionToProvider already decides it, and carrying the base
 * version each operation expects to still be true at commit time.
 */
export async function prepareClinicalTransaction(
  compositionSessionId: string,
  actor: ClinicalTransactionActor,
  options: { clientRequestId?: string; description?: string } = {},
): Promise<PublicClinicalTransaction> {
  const sessionId = text(compositionSessionId, 'compositionSessionId');
  const clientRequestId = options.clientRequestId?.trim() || undefined;

  if (clientRequestId) {
    const existing = await prisma.clinicalTransaction.findUnique({ where: { compositionSessionId_clientRequestId: { compositionSessionId: sessionId, clientRequestId } } });
    // 'partial' is also excluded from reuse (alongside 'failed'/'conflict'):
    // a retry after a partial fallback commit must re-prepare fresh
    // operations from each session's now-current state, not return the
    // same partially-done transaction back untouched. Every already-
    // succeeded operation's session has since moved to 'complete', so the
    // fresh prepare naturally re-types it as a benign update rather than a
    // duplicate create.
    if (existing) {
      owner(existing, actor);
      if (existing.status !== 'failed' && existing.status !== 'conflict' && existing.status !== 'partial') {
        const operations = await prisma.clinicalTransactionOperation.findMany({ where: { transactionId: existing.id }, orderBy: { createdAt: 'asc' } });
        return publicTransaction(existing, operations);
      }
      // A retryable terminal transaction (failed/conflict/partial) under
      // this same clientRequestId must be cleared before preparing fresh -
      // (compositionSessionId, clientRequestId) is unique, so a plain
      // create() here would otherwise violate that constraint on retry.
      // Operations cascade-delete with it.
      await prisma.clinicalTransaction.delete({ where: { id: existing.id } });
    }
  }

  const { session: validated, valid, children } = await validateCompositionSession(sessionId, actor);
  if (!valid) {
    // Per-form validity readout ("Discharge Summary valid / Medication 2
    // errors / Nursing Summary not started") so the UI can point the user at
    // exactly which child form needs fixing, not just "something's wrong".
    const messages = children.flatMap((child): Array<{ severity: 'error'; code?: string; path: string; message: string }> => {
      if (!child.sessionId) return [{ severity: 'error' as const, path: child.blockId, message: `${child.formId}: not started yet` }];
      if (child.valid === false) {
        const issues = child.issues && child.issues.length > 0 ? child.issues : [{ code: undefined, message: 'has validation errors' }];
        return issues.map((issue) => ({ severity: 'error' as const, code: issue.code, path: child.blockId, message: `${child.formId}: ${issue.message}` }));
      }
      return [];
    });
    throw new HttpError(422, 'Not every child form is valid yet - fix the invalid ones before saving together', {
      code: 'CLINICAL_TRANSACTION_VALIDATION_FAILED',
      messages,
    });
  }
  if (!validated.ehrId) throw new HttpError(422, 'This composition session has no resolved EHR - a patient context is required before saving');

  const childSessionIds = children.filter((child) => child.sessionId).map((child) => child.sessionId as string);
  const sessions = await prisma.formSession.findMany({ where: { id: { in: childSessionIds } } });
  const sessionById = new Map(sessions.map((row) => [row.id, row]));

  const operationInputs = children.filter((child) => child.sessionId).map((child) => {
    const session = sessionById.get(child.sessionId as string);
    if (!session) throw new HttpError(404, `Child form session ${child.sessionId} not found`);
    const baseVersionUid = currentReference(session);
    const type: OperationType = session.lifecycleState === 'complete' ? 'modification' : 'create';
    return { blockId: child.blockId, formSessionId: session.id, type, baseVersionUid };
  });

  const created = await prisma.$transaction(async (tx) => {
    const transaction = await tx.clinicalTransaction.create({
      data: {
        compositionSessionId: sessionId,
        ehrId: validated.ehrId as string,
        userId: actor.userId,
        authMode: actor.authMode,
        status: 'ready',
        ...(options.description ? { description: options.description } : {}),
        ...(clientRequestId ? { clientRequestId } : {}),
      },
    });
    await tx.clinicalTransactionOperation.createMany({
      data: operationInputs.map((op) => ({
        transactionId: transaction.id,
        formSessionId: op.formSessionId,
        blockId: op.blockId,
        type: op.type,
        ...(op.baseVersionUid ? { baseVersionUid: op.baseVersionUid } : {}),
        status: 'ready' as const,
      })),
    });
    const operations = await tx.clinicalTransactionOperation.findMany({ where: { transactionId: transaction.id }, orderBy: { createdAt: 'asc' } });
    return { transaction, operations };
  });

  return publicTransaction(created.transaction, created.operations);
}

export async function getClinicalTransaction(id: string, actor: ClinicalTransactionActor): Promise<PublicClinicalTransaction> {
  const { record, operations } = await loadTransaction(id, actor);
  return publicTransaction(record, operations);
}

async function markFailed(transactionId: string, error: { code?: string; message: string }, conflict = false): Promise<void> {
  await prisma.$transaction([
    prisma.clinicalTransaction.update({ where: { id: transactionId }, data: { status: conflict ? 'conflict' : 'failed', errorCode: error.code, errorMessage: error.message, revision: { increment: 1 } } }),
    prisma.clinicalTransactionOperation.updateMany({ where: { transactionId, status: { in: ['ready', 'pending'] } }, data: { status: conflict ? 'conflict' : 'failed', errorMessage: error.message } }),
  ]);
}

/**
 * Whether this Composition's grouped save must land as one real
 * Contribution (block if the active provider can't) or may fall back to a
 * best-effort sequential save - the Composition's own `requireAtomicCommit`
 * (its canonical_json extension) wins; unset defers to the connection-wide
 * `requireAtomicCommitByDefault` (itself defaulting to `true` - never
 * silently non-atomic unless a Composition explicitly opts out).
 */
async function resolveRequireAtomicCommit(compositionFormId: string): Promise<boolean> {
  const form = await prisma.form.findUnique({ where: { id: compositionFormId } });
  const definition = form ? getCompositionDefinition((form.canonical_json as any)?.extensions || {}) : undefined;
  if (definition?.requireAtomicCommit !== undefined) return definition.requireAtomicCommit;
  return getConfig().requireAtomicCommitByDefault ?? true;
}

/**
 * Non-atomic fallback commit: saves each operation independently via the
 * exact same single-composition commit() path submitFormSessionToProvider
 * uses (real per-form If-Match conflict detection included), continuing
 * through every operation even if an earlier one fails - a failed operation
 * never blocks the others, and a successful one is never rolled back. The
 * transaction's own final status honestly reflects the mixed outcome
 * ('partial') rather than ever reporting a blanket success.
 */
async function commitSequentialFallback(
  record: { id: string; ehrId: string; description: string | null },
  operations: Array<{ id: string; formSessionId: string; type: string; baseVersionUid: string | null; changeDescription: string | null }>,
  sessionById: Map<string, any>,
  compositionSession: { patientId: string; patientNamespace?: string },
  actor: ClinicalTransactionActor,
  repository: NonNullable<ReturnType<typeof getCompositionRepository>>,
): Promise<PublicClinicalTransaction> {
  let anyFailed = false;
  let anySucceeded = false;
  for (const op of operations) {
    const session = sessionById.get(op.formSessionId)!;
    try {
      const form = await prisma.form.findUnique({ where: { id: session.formId } });
      if (!form) throw new Error(`Form definition for session ${session.id} not found`);
      const definition = migrateCanonicalFormToV1({ ...(form.canonical_json as any), id: form.id }, form.id);
      const context: FormDataProviderContext = {
        mode: 'edit',
        patientId: compositionSession.patientId,
        ...(compositionSession.patientNamespace ? { patientNamespace: compositionSession.patientNamespace } : {}),
        ehrId: record.ehrId,
        sessionId: session.id,
        userId: actor.userId,
        authMode: actor.authMode,
      };
      const opType = op.type as OperationType;
      const result = await repository.commit({
        context,
        form: { id: form.id, version: form.version, definition },
        values: session.values as any,
        ...(op.baseVersionUid ? { reference: op.baseVersionUid } : {}),
        desiredLifecycleState: 'complete',
        ...(opType !== 'create' ? { desiredChangeType: opType } : {}),
        ...(op.changeDescription ? { changeDescription: op.changeDescription } : {}),
      }, 'submit');
      await applySuccessfulProviderCommit(session.id, {
        providerId: result.providerId,
        reference: result.reference,
        values: session.values as any,
        lifecycleState: result.lifecycleState,
        lifecycleConfirmed: result.lifecycleConfirmed,
        changeType: opType === 'create' ? undefined : opType,
        changeDescription: op.changeDescription || undefined,
        ehrId: typeof result.metadata?.ehrId === 'string' ? result.metadata.ehrId : record.ehrId,
      }, op.baseVersionUid || undefined);
      await prisma.clinicalTransactionOperation.update({ where: { id: op.id }, data: { status: 'committed', resultVersionUid: result.reference } });
      anySucceeded = true;
    } catch (error) {
      anyFailed = true;
      const message = error instanceof Error ? error.message : 'Unknown error saving this form';
      await prisma.clinicalTransactionOperation.update({ where: { id: op.id }, data: { status: 'failed', errorMessage: message } });
    }
  }
  const status = anyFailed ? (anySucceeded ? 'partial' : 'failed') : 'committed';
  const finalRecord = await prisma.clinicalTransaction.update({ where: { id: record.id }, data: {
    status,
    atomic: false,
    ...(status === 'failed' ? { errorCode: 'CLINICAL_TRANSACTION_SEQUENTIAL_FAILED', errorMessage: 'None of the forms could be saved' } : {}),
    revision: { increment: 1 },
  } });
  const finalOperations = await prisma.clinicalTransactionOperation.findMany({ where: { transactionId: record.id }, orderBy: { createdAt: 'asc' } });
  return publicTransaction(finalRecord, finalOperations);
}

/**
 * Commits an already-prepared, `ready` transaction: re-verifies every
 * operation's expected base version is still current (never a silent
 * commit over a stale base - a mismatch here fails the WHOLE transaction,
 * no partial writes, all local FormSession state untouched), builds each
 * operation's canonical Composition, and commits all of them together as
 * ONE real Contribution. `status: committing` is set via a conditional
 * update on `status: 'ready'` so a duplicate click/retry can never start a
 * second commit for the same transaction.
 */
export async function commitClinicalTransaction(id: string, actor: ClinicalTransactionActor): Promise<PublicClinicalTransaction> {
  const { record, operations } = await loadTransaction(id, actor);
  if (record.status === 'committed') return publicTransaction(record, operations); // idempotent: already done
  const claimed = await prisma.clinicalTransaction.updateMany({ where: { id: record.id, status: 'ready' }, data: { status: 'committing', revision: { increment: 1 } } });
  if (claimed.count === 0) {
    throw new HttpError(409, `Transaction is '${record.status}', not ready to commit`, { code: 'CLINICAL_TRANSACTION_NOT_READY' });
  }

  try {
    const sessions = await prisma.formSession.findMany({ where: { id: { in: operations.map((op) => op.formSessionId) } } });
    const sessionById = new Map(sessions.map((row) => [row.id, row]));

    // Concurrency re-check: every operation's base must still match reality.
    // A 'create' operation's baseVersionUid IS allowed to be non-null here -
    // prepareClinicalTransaction captures currentReference(session)
    // unconditionally (line ~196), and a 'create'-typed child (lifecycleState
    // not yet 'complete') routinely already has an autosaved EHRbase draft by
    // the time the user clicks "save all". Comparing against `Boolean(current)`
    // instead of the captured baseVersionUid (as a prior version of this check
    // did) treated that completely normal case - draft unchanged since prepare
    // - as a conflict, permanently failing every multi-block save whose child
    // sessions had ever autosaved. Comparing current to op.baseVersionUid
    // (both normalized to null) still catches the case the original comment
    // describes - "a 'create' operation's target must still not exist" reads
    // as "must still match what was true at prepare time", which for a
    // genuinely-new target means null on both sides - while also catching a
    // concurrent save that changed or newly created it since. Confirmed live
    // (2026-09-02): saving a freshly-filled "Anamnese" composition for a new
    // test patient failed 0/4 with "expected base X, found X" - identical
    // strings reported as a mismatch, because only Boolean(current) was ever
    // consulted for these 'create' ops.
    const conflicts: string[] = [];
    for (const op of operations) {
      const session = sessionById.get(op.formSessionId);
      if (!session) { conflicts.push(`${op.formSessionId}: no longer exists`); continue; }
      const current = currentReference(session) ?? null;
      const expected = op.baseVersionUid ?? null;
      if (current !== expected) {
        conflicts.push(`${op.formSessionId}: expected base ${expected || '(none)'}, found ${current || '(none)'}`);
      }
    }
    if (conflicts.length > 0) {
      const message = `One or more forms changed since this save was prepared: ${conflicts.join('; ')}`;
      await markFailed(record.id, { code: 'CLINICAL_TRANSACTION_CONFLICT', message }, true);
      throw new HttpError(409, message, { code: 'CLINICAL_TRANSACTION_CONFLICT' });
    }

    const repository = getCompositionRepository('ehrbase');
    const compositionSession = await getCompositionSession(record.compositionSessionId, actor);

    if (!repository?.supportsContribution) {
      const requireAtomic = await resolveRequireAtomicCommit(compositionSession.compositionFormId);
      if (requireAtomic) {
        const message = 'The active data provider does not support atomic multi-composition saves (Contribution)';
        await markFailed(record.id, { code: 'CONTRIBUTION_UNSUPPORTED', message });
        throw new HttpError(409, message, { code: 'CONTRIBUTION_UNSUPPORTED' });
      }
      if (!repository) {
        const message = 'The active data provider does not support saving Compositions at all';
        await markFailed(record.id, { code: 'PROVIDER_UNSUPPORTED', message });
        throw new HttpError(409, message, { code: 'PROVIDER_UNSUPPORTED' });
      }
      // This Composition explicitly opted out of requiring atomicity
      // (requireAtomicCommit: false) - fall back to a best-effort
      // sequential per-form save, exactly the same commit() path (and the
      // same real If-Match conflict detection) submitFormSessionToProvider
      // already uses for a single form. Never claims atomicity: represented
      // explicitly as 'partial' (some succeeded, some failed) rather than a
      // blanket "saved successfully", and no operation is skipped just
      // because an earlier one failed.
      return commitSequentialFallback(record, operations, sessionById, compositionSession, actor, repository);
    }

    const webTemplateCache = new Map<string, unknown>();
    const builtOperations = await Promise.all(operations.map(async (op, operationIndex) => {
      const session = sessionById.get(op.formSessionId)!;
      const form = await prisma.form.findUnique({ where: { id: session.formId } });
      if (!form) throw new HttpError(404, `Form definition for session ${session.id} not found`);
      const definition = migrateCanonicalFormToV1({ ...(form.canonical_json as any), id: form.id }, form.id);
      const templateId = definition.sourceTemplates?.[0]?.id;
      if (!templateId) throw new HttpError(422, `Form ${form.id} has no openEHR source template`);
      let webTemplateTree = webTemplateCache.get(templateId);
      if (!webTemplateTree) {
        const wt = await getRemoteWebTemplate(templateId);
        webTemplateTree = wt?.tree;
        if (webTemplateTree) webTemplateCache.set(templateId, webTemplateTree);
      }
      const data = buildCanonicalComposition(definition, session.values as any, webTemplateTree, { composerName: actor.userId });
      // EHRbase rejects change type CREATION whenever preceding_version_uid
      // is also set (a "creation" is definitionally the first version - see
      // the concurrency re-check above for why op.baseVersionUid can very
      // well be non-null even for a 'create'-typed operation: an autosaved
      // EHRbase draft already exists for a child that hasn't reached
      // lifecycleState 'complete' yet). Once a preceding version exists,
      // this commit is really writing the next version of that draft - a
      // modification - regardless of the app's own not-yet-'complete'
      // lifecycle label. Confirmed live (2026-09-02) as the very next
      // EHRbase-side rejection surfaced once the concurrency false-positive
      // above was fixed: "Invalid version. Change type CREATION, but also
      // set 'preceding_version_uid' attribute".
      const desiredChangeType: 'creation' | 'modification' | 'amendment' = op.baseVersionUid
        ? (op.type === 'create' ? 'modification' : toDesiredChangeType(op.type as OperationType))
        : toDesiredChangeType(op.type as OperationType);
      return {
        operationIndex,
        data,
        ...(op.baseVersionUid ? { precedingVersionUid: op.baseVersionUid } : {}),
        desiredChangeType,
        ...(op.changeDescription ? { changeDescription: op.changeDescription } : {}),
      };
    }));

    const context: FormDataProviderContext = {
      mode: 'edit',
      patientId: compositionSession.patientId,
      ...(compositionSession.patientNamespace ? { patientNamespace: compositionSession.patientNamespace } : {}),
      ehrId: record.ehrId,
      userId: actor.userId,
      authMode: actor.authMode,
    };

    const commitResult = await repository.commitContribution({
      context,
      operations: builtOperations,
      ...(record.description ? { transactionDescription: record.description } : {}),
    });

    const resultByIndex = new Map(commitResult.versions.map((v) => [v.operationIndex, v.versionUid]));
    await Promise.all(operations.map(async (op, operationIndex) => {
      const session = sessionById.get(op.formSessionId)!;
      const versionUid = resultByIndex.get(operationIndex);
      if (!versionUid) {
        await prisma.clinicalTransactionOperation.update({ where: { id: op.id }, data: { status: 'failed', errorMessage: 'No result version returned by the Contribution for this operation' } });
        return;
      }
      await applySuccessfulProviderCommit(session.id, {
        providerId: 'ehrbase',
        reference: versionUid,
        values: session.values as any,
        lifecycleState: 'complete',
        lifecycleConfirmed: true,
        changeType: op.type === 'create' ? undefined : (op.type as 'modification' | 'amendment'),
        changeDescription: op.changeDescription || undefined,
        ehrId: record.ehrId,
      }, op.baseVersionUid || undefined);
      await prisma.clinicalTransactionOperation.update({ where: { id: op.id }, data: { status: 'committed', resultVersionUid: versionUid } });
    }));

    const committed = await prisma.clinicalTransaction.update({ where: { id: record.id }, data: { status: 'committed', contributionUid: commitResult.contributionUid, atomic: true, revision: { increment: 1 } } });
    const finalOperations = await prisma.clinicalTransactionOperation.findMany({ where: { transactionId: record.id }, orderBy: { createdAt: 'asc' } });
    return publicTransaction(committed, finalOperations);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = error instanceof Error ? error.message : 'Unknown error committing the transaction';
    const code = (error as { code?: string })?.code;
    const isConflict = code === 'CONTRIBUTION_VERSION_CONFLICT' || code === 'CLINICAL_TRANSACTION_CONFLICT';
    await markFailed(record.id, { code, message }, isConflict);
    throw new HttpError(isConflict ? 409 : 502, message, { code: code || 'CLINICAL_TRANSACTION_COMMIT_FAILED' });
  }
}
