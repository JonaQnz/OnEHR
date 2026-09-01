-- CreateEnum
CREATE TYPE "IntegrationProtocol" AS ENUM ('fhir', 'openehr');

-- CreateTable
CREATE TABLE "integration_call_logs" (
    "id" TEXT NOT NULL,
    "protocol" "IntegrationProtocol" NOT NULL,
    "resource_type" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "request_body" JSONB,
    "response_body" JSONB,
    "status_code" INTEGER,
    "success" BOOLEAN NOT NULL,
    "error_message" TEXT,
    "ehr_id" TEXT,
    "patient_id" TEXT,
    "fhir_patient_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_call_logs_protocol_resource_type_idx" ON "integration_call_logs"("protocol", "resource_type");

-- CreateIndex
CREATE INDEX "integration_call_logs_ehr_id_idx" ON "integration_call_logs"("ehr_id");

-- CreateIndex
CREATE INDEX "integration_call_logs_created_at_idx" ON "integration_call_logs"("created_at");
