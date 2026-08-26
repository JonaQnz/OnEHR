import type { CompositionVersion, FormDataProviderContext } from 'core';
import {
  ehrbaseDataProvider,
  type CommitWithLifecycleInput,
  type CommitWithLifecycleResult,
  type ContributionCommitInput,
  type ContributionCommitResult,
  type ContributionDetails,
  type WithdrawInput,
  type WithdrawResult,
} from './ehrbaseDataProvider';

/**
 * The Clinical Editing Layer's abstraction over CDR-specific persistence
 * details (REST paths, ETag/If-Match, header quirks) - see Epic 2's plan.
 * Deliberately thin: it does not reimplement commit/withdraw, it exposes the
 * one CDR connector that already knows how to do this (`EhrbaseDataProvider`)
 * behind an interface the rest of the editing lifecycle can depend on
 * without importing EHRbase-specific types directly.
 */
export interface CompositionRepository {
  commit(input: CommitWithLifecycleInput, label: 'submit' | 'draft'): Promise<CommitWithLifecycleResult>;
  withdraw(input: WithdrawInput): Promise<WithdrawResult>;
  /** Lightweight version list (Epic 3) - metadata only, never full content. */
  getVersionHistory(context: FormDataProviderContext, compositionUid: string): Promise<CompositionVersion[]>;
  /** One version's full audit metadata + content, fetched lazily on demand. */
  getVersionContent(context: FormDataProviderContext, versionUid: string): Promise<{ version: CompositionVersion; flat: Record<string, unknown> } | undefined>;
  /**
   * Whether this CDR can commit several Compositions as one real openEHR
   * CONTRIBUTION (Epic 4) - an explicit capability flag, not inferred from
   * whether commitContribution/getContribution happen to be present.
   * Callers (clinicalTransactionService) MUST check this before relying on
   * atomicity, and MUST block rather than silently fall back to sequential
   * per-composition commits when the caller requires atomic commit - see
   * Epic 4's "never silently downgrade" requirement.
   */
  supportsContribution: boolean;
  commitContribution(input: ContributionCommitInput): Promise<ContributionCommitResult>;
  getContribution(context: FormDataProviderContext, contributionUid: string): Promise<ContributionDetails>;
}

const repositories = new Map<string, CompositionRepository>();

function ehrbaseRepository(): CompositionRepository {
  return {
    commit: (input, label) => ehrbaseDataProvider.commitWithLifecycle(input, label),
    withdraw: (input) => ehrbaseDataProvider.withdraw(input),
    getVersionHistory: (context, compositionUid) => ehrbaseDataProvider.getVersionHistory(context, compositionUid),
    getVersionContent: (context, versionUid) => ehrbaseDataProvider.getVersionContent(context, versionUid),
    // Confirmed live against the real sandbox EHRbase (Epic 4 research):
    // POST /ehr/{ehr_id}/contribution correctly commits multiple
    // Compositions atomically, honoring change_type/description/committer/
    // preceding_version_uid and rejecting a stale preceding_version_uid with
    // a real 412 - so this connector genuinely supports it, not just "has
    // the methods".
    supportsContribution: true,
    commitContribution: (input) => ehrbaseDataProvider.commitContribution(input),
    getContribution: (context, contributionUid) => ehrbaseDataProvider.getContribution(context, contributionUid),
  };
}

/**
 * Returns the CompositionRepository for a given FormDataProvider id, or
 * `undefined` when that provider has no real openEHR versioning/lifecycle
 * mechanism to expose (e.g. n8n) - an explicit capability signal callers
 * must check, never a silent no-op stand-in.
 */
export function getCompositionRepository(providerId: string | undefined): CompositionRepository | undefined {
  if (providerId !== 'ehrbase') return undefined;
  const cached = repositories.get(providerId);
  if (cached) return cached;
  const repo = ehrbaseRepository();
  repositories.set(providerId, repo);
  return repo;
}
