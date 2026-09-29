-- Only a JEFE_AREA can hold the task-creation grant (ADMIN always can; others never).
ALTER TABLE "users" ADD CONSTRAINT "users_can_create_tasks_jefe_only"
  CHECK (NOT "canCreateTasks" OR "role" = 'JEFE_AREA');
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_can_create_tasks_jefe_only"
  CHECK (NOT "canCreateTasks" OR "role" = 'JEFE_AREA');
