-- Epic 2: Clinical Editing Lifecycle
CREATE TYPE "FormSessionLifecycleState" AS ENUM ('new', 'incomplete', 'complete', 'deleted');
CREATE TYPE "FormSessionChangeType" AS ENUM ('modification', 'amendment');

ALTER TABLE "form_sessions"
  ADD COLUMN "lifecycle_state" "FormSessionLifecycleState" NOT NULL DEFAULT 'new',
  ADD COLUMN "lifecycle_confirmed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "change_type" "FormSessionChangeType",
  ADD COLUMN "change_description" TEXT;

-- Existing sessions already carry real composition references, so their
-- lifecycle should reflect that instead of defaulting to "new" (which means
-- "no server version yet"): a session with a provider/draft reference has at
-- least a draft version; a submitted session is complete.
UPDATE "form_sessions"
SET "lifecycle_state" = 'incomplete'
WHERE "lifecycle_state" = 'new' AND ("provider_reference" IS NOT NULL OR "draft_reference" IS NOT NULL);

UPDATE "form_sessions"
SET "lifecycle_state" = 'complete'
WHERE "status" = 'submitted' AND "provider_reference" IS NOT NULL;
