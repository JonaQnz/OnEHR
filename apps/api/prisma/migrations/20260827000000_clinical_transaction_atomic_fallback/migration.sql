-- Per-Composition requireAtomicCommit setting: a non-atomic sequential
-- fallback commit is now possible when a Composition opts out of requiring
-- a real Contribution and the active provider doesn't support one.
ALTER TYPE "ClinicalTransactionStatus" ADD VALUE 'partial';

ALTER TABLE "clinical_transactions" ADD COLUMN "atomic" BOOLEAN;
