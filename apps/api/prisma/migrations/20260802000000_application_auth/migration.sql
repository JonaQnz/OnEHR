CREATE TYPE "UserStatus" AS ENUM ('active', 'inactive');
CREATE TYPE "ApplicationRole" AS ENUM ('USER', 'ADMIN');

CREATE TABLE "application_users" (
  "id" TEXT NOT NULL,
  "username" TEXT,
  "display_name" TEXT,
  "email" TEXT,
  "password_hash" TEXT,
  "status" "UserStatus" NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "last_login_at" TIMESTAMP(3),
  CONSTRAINT "application_users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "application_users_username_key" ON "application_users"("username");

CREATE TABLE "role_assignments" (
  "user_id" TEXT NOT NULL,
  "role" "ApplicationRole" NOT NULL,
  CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("user_id", "role")
);

CREATE TABLE "identity_links" (
  "id" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "external_subject" TEXT NOT NULL,
  "local_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "identity_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "identity_links_issuer_external_subject_key" ON "identity_links"("issuer", "external_subject");
CREATE INDEX "identity_links_local_user_id_idx" ON "identity_links"("local_user_id");

CREATE TABLE "application_sessions" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "application_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "application_sessions_user_id_idx" ON "application_sessions"("user_id");
CREATE INDEX "application_sessions_expires_at_idx" ON "application_sessions"("expires_at");

CREATE TABLE "audit_events" (
  "id" TEXT NOT NULL,
  "actor_user_id" TEXT,
  "action" TEXT NOT NULL,
  "resource_type" TEXT NOT NULL,
  "resource_id" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "audit_events_actor_user_id_idx" ON "audit_events"("actor_user_id");
CREATE INDEX "audit_events_action_idx" ON "audit_events"("action");

ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "application_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "identity_links" ADD CONSTRAINT "identity_links_local_user_id_fkey" FOREIGN KEY ("local_user_id") REFERENCES "application_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "application_sessions" ADD CONSTRAINT "application_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "application_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "application_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
