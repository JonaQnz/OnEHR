import prisma from '../db/prisma';
import type { Prisma } from '@prisma/client';

/**
 * The write side of the Epic 3 local version-history overlay (see
 * compositionHistoryService.ts for the read/enrichment side - kept in its
 * own module specifically so formSessionService.ts, which calls this right
 * after a successful save, and compositionHistoryService.ts, which reads it
 * back, never need to import each other).
 *
 * Records what Forms itself just did to produce `versionUid` - a best-effort
 * side write that never blocks or fails the save that triggered it, exactly
 * like the existing provider-push failure handling in formSessionService.ts.
 */
export interface CompositionVersionEventInput {
  versionUid: string;
  compositionUid: string;
  ehrId: string;
  formSessionId: string;
  lifecycleState: string;
  changeType?: string | null;
  changeDescription?: string | null;
}

/**
 * The strict variant used when a version event is part of reconciling an
 * already-accepted CDR commit: it runs on the caller's transaction client so
 * the event is confirmed together with the FormSession/operation update, and
 * an event that cannot be recorded rolls the whole reconcile step back.
 * Upsert-by-versionUid keeps a repeated reconcile side-effect free.
 */
export async function recordCompositionVersionEventInTransaction(
  client: Prisma.TransactionClient,
  input: CompositionVersionEventInput,
): Promise<void> {
  await client.compositionVersionEvent.upsert({
    where: { versionUid: input.versionUid },
    create: {
      versionUid: input.versionUid,
      compositionUid: input.compositionUid,
      ehrId: input.ehrId,
      formSessionId: input.formSessionId,
      lifecycleState: input.lifecycleState as any,
      changeType: (input.changeType || undefined) as any,
      changeDescription: input.changeDescription || undefined,
    },
    update: {
      lifecycleState: input.lifecycleState as any,
      changeType: (input.changeType || undefined) as any,
      changeDescription: input.changeDescription || undefined,
    },
  });
}

export async function recordCompositionVersionEvent(input: CompositionVersionEventInput): Promise<void> {
  try {
    await recordCompositionVersionEventInTransaction(prisma, input);
  } catch (error) {
    console.warn('[compositionVersionEvents] Could not record version event (history for this version will fall back to CDR defaults):', error instanceof Error ? error.message : error);
  }
}
