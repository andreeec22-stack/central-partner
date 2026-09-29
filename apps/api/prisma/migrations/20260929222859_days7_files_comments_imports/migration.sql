-- CreateEnum
CREATE TYPE "WhatsAppDeliveryStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "excel_imports" ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedById" UUID,
ADD COLUMN     "createdCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "skippedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalRows" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "status" SET DEFAULT 'PROCESSING';

-- AlterTable
ALTER TABLE "workspace_branding" ADD COLUMN     "logoKey" VARCHAR(512);

-- CreateTable
CREATE TABLE "whatsapp_notification_logs" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "taskId" UUID,
    "phoneNumber" VARCHAR(20) NOT NULL,
    "type" "NotificationType" NOT NULL,
    "status" "WhatsAppDeliveryStatus" NOT NULL,
    "reason" VARCHAR(500),
    "providerId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatsapp_notification_logs_userId_taskId_createdAt_idx" ON "whatsapp_notification_logs"("userId", "taskId", "createdAt");

-- AddForeignKey
ALTER TABLE "whatsapp_notification_logs" ADD CONSTRAINT "whatsapp_notification_logs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_notification_logs" ADD CONSTRAINT "whatsapp_notification_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
