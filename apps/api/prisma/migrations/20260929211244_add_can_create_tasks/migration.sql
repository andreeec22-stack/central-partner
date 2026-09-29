-- AlterTable
ALTER TABLE "invitations" ADD COLUMN     "canCreateTasks" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "canCreateTasks" BOOLEAN NOT NULL DEFAULT false;
