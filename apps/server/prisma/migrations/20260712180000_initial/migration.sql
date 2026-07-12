CREATE TYPE "DeviceStatus" AS ENUM ('online', 'offline', 'revoked');
CREATE TYPE "JobStatus" AS ENUM ('queued', 'dispatched', 'running', 'waiting_for_input', 'completed', 'failed', 'cancelled', 'disconnected');
CREATE TYPE "OutputStream" AS ENUM ('stdout', 'stderr', 'system');

CREATE TABLE "User" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "email" VARCHAR(320) NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Session" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "tokenHash" CHAR(64) NOT NULL,
  "csrfTokenHash" CHAR(64) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Device" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "platform" VARCHAR(50) NOT NULL,
  "architecture" VARCHAR(50) NOT NULL,
  "agentVersion" VARCHAR(50) NOT NULL,
  "status" "DeviceStatus" NOT NULL DEFAULT 'offline',
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeviceCredential" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "deviceId" UUID NOT NULL,
  "credentialHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "DeviceCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PairingCode" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "codeHash" CHAR(64) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PairingCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Repository" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "deviceId" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "absolutePath" VARCHAR(4096) NOT NULL,
  "description" VARCHAR(1000),
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "allowCustomCommands" BOOLEAN NOT NULL DEFAULT false,
  "shell" VARCHAR(4096) NOT NULL DEFAULT '/bin/zsh',
  "shellArgs" JSONB NOT NULL,
  "inheritedEnvironment" JSONB NOT NULL,
  "isGitRepository" BOOLEAN,
  "branch" VARCHAR(500),
  "repositoryRoot" VARCHAR(4096),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Action" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "repositoryId" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "command" VARCHAR(16384) NOT NULL,
  "workingDirectory" VARCHAR(4096) NOT NULL DEFAULT '',
  "interactive" BOOLEAN NOT NULL DEFAULT false,
  "persistent" BOOLEAN NOT NULL DEFAULT false,
  "confirmationRequired" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Action_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Job" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "deviceId" UUID NOT NULL,
  "repositoryId" UUID NOT NULL,
  "actionId" UUID,
  "command" VARCHAR(16384) NOT NULL,
  "workingDirectory" VARCHAR(4096) NOT NULL DEFAULT '',
  "status" "JobStatus" NOT NULL DEFAULT 'queued',
  "interactive" BOOLEAN NOT NULL DEFAULT false,
  "persistent" BOOLEAN NOT NULL DEFAULT false,
  "exitCode" INTEGER,
  "statusDetail" VARCHAR(2000),
  "retainedOutputBytes" INTEGER NOT NULL DEFAULT 0,
  "outputTruncated" BOOLEAN NOT NULL DEFAULT false,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JobOutputChunk" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "jobId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "stream" "OutputStream" NOT NULL,
  "data" TEXT NOT NULL,
  "byteLength" INTEGER NOT NULL,
  "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JobOutputChunk_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID,
  "deviceId" UUID,
  "action" VARCHAR(100) NOT NULL,
  "ipAddress" VARCHAR(100),
  "userAgent" VARCHAR(500),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
CREATE INDEX "Device_userId_idx" ON "Device"("userId");
CREATE INDEX "Device_status_lastSeenAt_idx" ON "Device"("status", "lastSeenAt");
CREATE UNIQUE INDEX "DeviceCredential_credentialHash_key" ON "DeviceCredential"("credentialHash");
CREATE INDEX "DeviceCredential_deviceId_idx" ON "DeviceCredential"("deviceId");
CREATE UNIQUE INDEX "PairingCode_codeHash_key" ON "PairingCode"("codeHash");
CREATE INDEX "PairingCode_userId_idx" ON "PairingCode"("userId");
CREATE INDEX "PairingCode_expiresAt_idx" ON "PairingCode"("expiresAt");
CREATE UNIQUE INDEX "Repository_deviceId_absolutePath_key" ON "Repository"("deviceId", "absolutePath");
CREATE INDEX "Repository_deviceId_idx" ON "Repository"("deviceId");
CREATE INDEX "Action_repositoryId_idx" ON "Action"("repositoryId");
CREATE INDEX "Job_userId_createdAt_idx" ON "Job"("userId", "createdAt");
CREATE INDEX "Job_deviceId_status_idx" ON "Job"("deviceId", "status");
CREATE INDEX "Job_repositoryId_createdAt_idx" ON "Job"("repositoryId", "createdAt");
CREATE UNIQUE INDEX "JobOutputChunk_jobId_sequence_key" ON "JobOutputChunk"("jobId", "sequence");
CREATE INDEX "JobOutputChunk_jobId_timestamp_idx" ON "JobOutputChunk"("jobId", "timestamp");
CREATE INDEX "AuditEvent_userId_createdAt_idx" ON "AuditEvent"("userId", "createdAt");
CREATE INDEX "AuditEvent_deviceId_createdAt_idx" ON "AuditEvent"("deviceId", "createdAt");
CREATE INDEX "AuditEvent_action_createdAt_idx" ON "AuditEvent"("action", "createdAt");

ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Device" ADD CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceCredential" ADD CONSTRAINT "DeviceCredential_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PairingCode" ADD CONSTRAINT "PairingCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Action" ADD CONSTRAINT "Action_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "Action"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JobOutputChunk" ADD CONSTRAINT "JobOutputChunk_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
