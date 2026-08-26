import type { CompositionVersion, FormDataProviderContext } from 'core';
import {
  ehrbaseDataProvider,
  type CommitWithLifecycleInput,
  type CommitWithLifecycleResult,
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
}

const repositories = new Map<string, CompositionRepository>();

function ehrbaseRepository(): CompositionRepository {
  return {
    commit: (input, label) => ehrbaseDataProvider.commitWithLifecycle(input, label),
    withdraw: (input) => ehrbaseDataProvider.withdraw(input),
    getVersionHistory: (context, compositionUid) => ehrbaseDataProvider.getVersionHistory(context, compositionUid),
    getVersionContent: (context, versionUid) => ehrbaseDataProvider.getVersionContent(context, versionUid),
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
