CREATE TABLE "data_widgets" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "aql_function_id" TEXT NOT NULL,
  "configuration" JSONB NOT NULL DEFAULT '{}',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "data_widgets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "data_widgets_aql_function_id_enabled_idx" ON "data_widgets"("aql_function_id", "enabled");
