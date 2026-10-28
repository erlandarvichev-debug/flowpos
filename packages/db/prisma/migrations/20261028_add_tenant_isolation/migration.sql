-- FP-007: Add Tenant isolation layer
-- Create tenants table
CREATE TABLE "tenants" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

-- Add tenant_id to organizations (with migration path)
ALTER TABLE "organizations" ADD COLUMN "tenant_id" TEXT;

-- Create temporary default tenant for backward compatibility
INSERT INTO "tenants" ("id", "name", "isActive", "createdAt", "updatedAt")
  VALUES ('default-tenant', 'Default Tenant (Pre-Migration)', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Backfill existing organizations with default tenant
UPDATE "organizations" SET "tenant_id" = 'default-tenant' WHERE "tenant_id" IS NULL;

-- Make tenant_id required and add constraints
ALTER TABLE "organizations" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_tenant_id_id_unique"
  UNIQUE ("tenant_id", "id");
CREATE INDEX "organizations_tenant_id_idx" ON "organizations"("tenant_id");

-- Add tenant_id to users
ALTER TABLE "users" ADD COLUMN "tenant_id" TEXT;
UPDATE "users" u SET "tenant_id" = 'default-tenant'
  FROM "organizations" o WHERE u."organization_id" = o."id";
ALTER TABLE "users" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_email_unique"
  UNIQUE ("tenant_id", "email");
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_org_id_unique"
  UNIQUE ("tenant_id", "organization_id", "id");
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");

-- Create grants table (authorization)
CREATE TABLE "grants" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "scope" TEXT NOT NULL DEFAULT 'organization',
  "expires_at" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "grants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "grants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "grants_unique" UNIQUE ("tenant_id", "organization_id", "user_id", "action")
);
CREATE INDEX "grants_tenant_id_idx" ON "grants"("tenant_id");
CREATE INDEX "grants_user_id_idx" ON "grants"("user_id");

-- Add tenant_id to refresh_tokens
ALTER TABLE "refresh_tokens" ADD COLUMN "tenant_id" TEXT;
UPDATE "refresh_tokens" rt SET "tenant_id" = 'default-tenant'
  FROM "users" u WHERE rt."user_id" = u."id";
ALTER TABLE "refresh_tokens" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
CREATE INDEX "refresh_tokens_tenant_id_idx" ON "refresh_tokens"("tenant_id");

-- Add tenant_id to audit_log
ALTER TABLE "audit_log" ADD COLUMN "tenant_id" TEXT;
UPDATE "audit_log" SET "tenant_id" = 'default-tenant' WHERE "tenant_id" IS NULL;
ALTER TABLE "audit_log" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
CREATE INDEX "audit_log_tenant_id_idx" ON "audit_log"("tenant_id");

-- Add tenant_id to documents
ALTER TABLE "documents" ADD COLUMN "tenant_id" TEXT;
UPDATE "documents" d SET "tenant_id" = 'default-tenant'
  FROM "organizations" o WHERE d."organization_id" = o."id" OR d."organization_id" IS NULL;
ALTER TABLE "documents" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_onec_unique"
  UNIQUE ("tenant_id", "onec_base", "onec_guid");
CREATE INDEX "documents_tenant_id_idx" ON "documents"("tenant_id");
CREATE INDEX "documents_organization_id_idx" ON "documents"("organization_id");
