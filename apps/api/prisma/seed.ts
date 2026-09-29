// Development seed: a demo workspace with one account per role and a week of
// tasks in every state. Re-running replaces the demo workspace (and only it).
//
//   npm run db:seed -w @central-partner/api
//
// All demo accounts use the password below. Never run against production.
import { PrismaClient, type Priority, type Role, type TaskStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

export const DEMO_PASSWORD = 'demo-12345';
const SLUG = 'demo-central-partner';

const prisma = new PrismaClient();

const semaphoreFor = (p: number) => (p >= 90 ? 'GREEN' : p >= 70 ? 'YELLOW' : 'RED');
const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000);

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');

  await prisma.workspace.deleteMany({ where: { slug: SLUG } });
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const ws = await prisma.workspace.create({
    data: {
      name: 'Central Partner Demo',
      slug: SLUG,
      branding: { create: { workspaceName: 'Central Partner Demo', tagline: 'Gastronomía • Personas • Crecimiento' } },
    },
  });

  const dept = async (name: string, slug: string, color: string) =>
    prisma.department.create({ data: { workspaceId: ws.id, name, slug, color } });
  const marketing = await dept('Marketing', 'marketing', '#8b5cf6');
  const finanzas = await dept('Finanzas', 'finanzas', '#0ea5e9');
  const rrhh = await dept('RRHH - Nómina', 'rrhh-nomina', '#f97316');

  const user = (email: string, displayName: string, role: Role, departmentId: string | null, canCreateTasks = false) =>
    prisma.user.create({
      data: {
        workspaceId: ws.id,
        email,
        displayName,
        role,
        departmentId,
        canCreateTasks,
        passwordHash,
        timezone: 'America/Bogota',
        notificationPrefs: { create: { workspaceId: ws.id } },
      },
    });

  const director = await user('director@demo.local', 'Diana Directora', 'ADMIN', null);
  const jefeMkt = await user('jefe.marketing@demo.local', 'Mario Jefe', 'JEFE_AREA', marketing.id, true);
  const ana = await user('ana@demo.local', 'Ana Gómez', 'USER', marketing.id);
  const luis = await user('luis@demo.local', 'Luis Pérez', 'USER', marketing.id);
  const jefeFin = await user('jefe.finanzas@demo.local', 'Fernanda Jefa', 'JEFE_AREA', finanzas.id, false);
  const carla = await user('carla@demo.local', 'Carla Ruiz', 'USER', finanzas.id);
  await user('lector@demo.local', 'Leo Lector', 'VIEWER', marketing.id);
  await user('nomina@demo.local', 'Nora Nómina', 'USER', rrhh.id);

  await prisma.department.update({ where: { id: marketing.id }, data: { headId: jefeMkt.id } });
  await prisma.department.update({ where: { id: finanzas.id }, data: { headId: jefeFin.id } });

  type Seed = {
    title: string;
    dept: string;
    to: string | null;
    by: string;
    progress: number;
    status?: TaskStatus;
    priority?: Priority;
    due?: number;
    kpiTarget?: string;
    kpiActual?: string;
    blockReason?: string;
  };
  const tasks: Seed[] = [
    { title: 'Publicar 5 posts de la campaña de octubre', dept: marketing.id, to: ana.id, by: jefeMkt.id, progress: 75, priority: 'HIGH', due: 2, kpiTarget: '5 posts', kpiActual: '4 posts' },
    { title: 'Informe semanal de leads', dept: marketing.id, to: luis.id, by: jefeMkt.id, progress: 100, due: -1, kpiTarget: '50 leads', kpiActual: '53 leads' },
    { title: 'Aprobar pauta en Meta Ads', dept: marketing.id, to: ana.id, by: jefeMkt.id, progress: 50, status: 'BLOCKED', priority: 'URGENT', due: 1, blockReason: 'Esperando aprobación de presupuesto de finanzas' },
    { title: 'Brief para diseño de menú de temporada', dept: marketing.id, to: luis.id, by: jefeMkt.id, progress: 25, due: 4 },
    { title: 'Calendario editorial de noviembre', dept: marketing.id, to: null, by: jefeMkt.id, progress: 0, priority: 'LOW', due: 6 },
    { title: 'Conciliación bancaria septiembre', dept: finanzas.id, to: carla.id, by: director.id, progress: 50, priority: 'HIGH', due: 0, kpiTarget: '3 cuentas' },
    { title: 'Cierre de caja menor', dept: finanzas.id, to: carla.id, by: director.id, progress: 100, due: -2 },
    { title: 'Flujo de caja proyectado Q4', dept: finanzas.id, to: jefeFin.id, by: director.id, progress: 75, priority: 'URGENT', due: 3 },
    { title: 'Liquidar nómina quincena 2', dept: rrhh.id, to: null, by: director.id, progress: 25, priority: 'HIGH', due: 1 },
  ];

  for (const t of tasks) {
    const status: TaskStatus = t.status ?? (t.progress === 100 ? 'DONE' : t.progress > 0 ? 'IN_PROGRESS' : 'TODO');
    const now = new Date();
    await prisma.task.create({
      data: {
        workspaceId: ws.id,
        departmentId: t.dept,
        assignedToId: t.to,
        createdById: t.by,
        title: t.title,
        status,
        priority: t.priority ?? 'MEDIUM',
        progress: t.progress,
        semaphore: semaphoreFor(t.progress),
        dueDate: t.due !== undefined ? daysFromNow(t.due) : null,
        kpiTarget: t.kpiTarget ?? null,
        kpiActual: t.kpiActual ?? null,
        kpiRecordedAt: t.kpiActual ? now : null,
        blockReason: t.blockReason ?? null,
        blockedSince: t.blockReason ? now : null,
        blockedByUserId: t.blockReason ? t.to : null,
        wasBlocked: !!t.blockReason,
        actualStartDate: t.progress > 0 ? daysFromNow(-2) : null,
        actualCompletionDate: status === 'DONE' ? now : null,
        collaborationParticipantIds: [t.by, ...(t.to ? [t.to] : [])],
      },
    });
  }

  console.log(`Seeded "${ws.name}" — ${tasks.length} tasks. Password for every account: ${DEMO_PASSWORD}`);
  console.log('Accounts: director@, jefe.marketing@ (can create), jefe.finanzas@ (cannot), ana@, luis@, carla@, lector@, nomina@ — all @demo.local');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
