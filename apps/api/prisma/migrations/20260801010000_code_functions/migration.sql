CREATE TABLE IF NOT EXISTS "code_functions" (
  "id" TEXT NOT NULL,
  "package_name" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "source" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "code_functions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "code_functions_package_name_name_key" ON "code_functions"("package_name", "name");
CREATE INDEX IF NOT EXISTS "code_functions_enabled_idx" ON "code_functions"("enabled");
