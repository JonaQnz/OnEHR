ALTER TABLE "form_sessions"
  ADD COLUMN IF NOT EXISTS "runtime_context" JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS "aql_functions" (
  "id" TEXT NOT NULL,
  "package_name" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "query" TEXT NOT NULL,
  "parameters" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "autoload" BOOLEAN NOT NULL DEFAULT true,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "aql_functions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "aql_functions_package_name_name_key"
  ON "aql_functions"("package_name", "name");
CREATE INDEX IF NOT EXISTS "aql_functions_enabled_autoload_idx"
  ON "aql_functions"("enabled", "autoload");
