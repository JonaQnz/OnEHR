-- AlterTable
ALTER TABLE "patients" ADD COLUMN "fhir_patient_id" TEXT;

-- AlterTable
ALTER TABLE "integration_call_logs" ADD COLUMN "form_id" TEXT,
ADD COLUMN "session_id" TEXT;

-- CreateIndex
CREATE INDEX "integration_call_logs_form_id_idx" ON "integration_call_logs"("form_id");
