-- Epic 4: openEHR CONTRIBUTION support - ClinicalTransaction
CREATE TYPE "ClinicalTransactionStatus" AS ENUM ('draft', 'validating', 'ready', 'committing', 'committed', 'failed', 'conflict');
CREATE TYPE "ClinicalTransactionOperationType" AS ENUM ('create', 'modification', 'amendment', 'delete');
CREATE TYPE "ClinicalTransactionOperationStatus" AS ENUM ('pending', 'ready', 'committed', 'failed', 'conflict');

CREATE TABLE "clinical_transactions" (
  "id" TEXT NOT NULL,
  "composition_session_id" TEXT NOT NULL,
  "ehr_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "auth_mode" TEXT NOT NULL,
  "status" "ClinicalTransactionStatus" NOT NULL DEFAULT 'draft',
  "description" TEXT,
  "contribution_uid" TEXT,
  "client_request_id" TEXT,
  "error_code" TEXT,
  "error_message" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "clinical_transactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "clinical_transactions_composition_session_id_client_reque_key" ON "clinical_transactions"("composition_session_id", "client_request_id");
CREATE INDEX "clinical_transactions_composition_session_id_idx" ON "clinical_transactions"("composition_session_id");
CREATE INDEX "clinical_transactions_user_id_updated_at_idx" ON "clinical_transactions"("user_id", "updated_at");

CREATE TABLE "clinical_transaction_operations" (
  "id" TEXT NOT NULL,
  "transaction_id" TEXT NOT NULL,
  "form_session_id" TEXT NOT NULL,
  "block_id" TEXT,
  "type" "ClinicalTransactionOperationType" NOT NULL,
  "base_version_uid" TEXT,
  "result_version_uid" TEXT,
  "status" "ClinicalTransactionOperationStatus" NOT NULL DEFAULT 'pending',
  "required" BOOLEAN NOT NULL DEFAULT true,
  "change_description" TEXT,
  "error_code" TEXT,
  "error_message" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "clinical_transaction_operations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "clinical_transaction_operations_transaction_id_idx" ON "clinical_transaction_operations"("transaction_id");
CREATE INDEX "clinical_transaction_operations_form_session_id_idx" ON "clinical_transaction_operations"("form_session_id");

ALTER TABLE "clinical_transaction_operations" ADD CONSTRAINT "clinical_transaction_operations_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "clinical_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
