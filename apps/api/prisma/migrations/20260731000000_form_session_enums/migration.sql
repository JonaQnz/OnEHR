-- Fail before changing the column type if production data contains values the
-- application cannot represent. This preserves existing session semantics.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "form_sessions"
    WHERE "mode" NOT IN ('create', 'edit', 'view', 'prefill')
  ) THEN
    RAISE EXCEPTION 'form_sessions contains unsupported mode values';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "form_sessions"
    WHERE "status" NOT IN ('draft', 'in_progress', 'ready', 'submitted', 'failed', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'form_sessions contains unsupported status values';
  END IF;
END $$;

CREATE TYPE "FormSessionMode" AS ENUM ('create', 'edit', 'view', 'prefill');
CREATE TYPE "FormSessionStatus" AS ENUM ('draft', 'in_progress', 'ready', 'submitted', 'failed', 'cancelled');

ALTER TABLE "form_sessions"
  ALTER COLUMN "mode" DROP DEFAULT,
  ALTER COLUMN "mode" TYPE "FormSessionMode" USING "mode"::"FormSessionMode",
  ALTER COLUMN "mode" SET DEFAULT 'create';

ALTER TABLE "form_sessions"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "FormSessionStatus" USING "status"::"FormSessionStatus",
  ALTER COLUMN "status" SET DEFAULT 'draft';
