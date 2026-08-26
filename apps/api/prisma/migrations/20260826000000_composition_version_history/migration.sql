-- Epic 3: Version History, Audit & Semantic Diff
CREATE TABLE "composition_version_events" (
  "id" TEXT NOT NULL,
  "version_uid" TEXT NOT NULL,
  "composition_uid" TEXT NOT NULL,
  "ehr_id" TEXT NOT NULL,
  "form_session_id" TEXT NOT NULL,
  "lifecycle_state" "FormSessionLifecycleState" NOT NULL,
  "change_type" "FormSessionChangeType",
  "change_description" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "composition_version_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "composition_version_events_version_uid_key" ON "composition_version_events"("version_uid");
CREATE INDEX "composition_version_events_composition_uid_idx" ON "composition_version_events"("composition_uid");
CREATE INDEX "composition_version_events_form_session_id_idx" ON "composition_version_events"("form_session_id");
