// Development seed with 13 real areas from director's Excel (Central Partner)
// History: 3 closed weeks + current week in progress
//
//   npm run db:seed -w @central-partner/api
//
// All demo accounts use password below. Never run against production.
import { Prisma, PrismaClient, type FunctionFrequency, type FunctionFulfillment, type KpiType, type Priority, type Role, type TaskStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { addDays, dayToDate, isoWeek, localDay, mondayOf, saturdayOf } from '../src/lib/week';
import { buildWeekData } from '../src/modules/weeks/week-data';

export const DEMO_PASSWORD = 'demo-12345';
const SLUG = 'demo-central-partner';
const TZ = 'America/Lima';
const HISTORY_WEEKS = 3;

const prisma = new PrismaClient();

const at = (day: string) => new Date(`${day}T17:00:00.000Z`);

interface KpiSeed {
  title: string;
  type: KpiType;
  unit?: string;
  target: number;
  lesserIsBetter?: boolean;
  history: number[];
}

interface FunctionSeed {
  title: string;
  frequency: FunctionFrequency;
  history: FunctionFulfillment[];
}

interface TaskSeed {
  title: string;
  day: number;
  to: string | null;
  progress: number;
  priority?: Priority;
  status?: TaskStatus;
  blockReason?: string;
  observation?: string;
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');

  await prisma.workspace.deleteMany({ where: { slug: SLUG } });
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const ws = await prisma.workspace.create({
    data: {
      name: 'Central Partner',
      slug: SLUG,
      timezone: TZ,
      branding: { create: { workspaceName: 'Central Partner', tagline: 'Gastronomía • Personas • Crecimiento' } },
    },
  });

  const dept = async (name: string, slug: string, color: string) => prisma.department.create({ data: { workspaceId: ws.id, name, slug, color } });
  
  // 13 areas from director's Excel
  const depts = await Promise.all([
    dept('Marketing', 'marketing', '#8b5cf6'),
    dept('Community', 'community', '#ec4899'),
    dept('Diseño', 'diseno', '#06b6d4'),
    dept('Diseño Audiovisual', 'diseno-audiovisual', '#0ea5e9'),
    dept('RRHH - Nómina', 'rrhh-nomina', '#f97316'),
    dept('RRHH - Relaciones Sociales', 'rrhh-rrss', '#d97706'),
    dept('Clima Laboral', 'clima-laboral', '#a855f7'),
    dept('Finanzas', 'finanzas', '#0ea5e9'),
    dept('Tesorería', 'tesoreria', '#3b82f6'),
    dept('Asist. Contable', 'asist-contable', '#6366f1'),
    dept('Prácticante Contable', 'pract-contable', '#8b5cf6'),
    dept('Auxiliar Contable', 'aux-contable', '#7c3aed'),
    dept('Auditoría y Calidad', 'auditoria-calidad', '#1e40af'),
  ]);

  const [marketing, community, diseno, audiovisual, rhhnomina, rrhss, clima, finanzas, tesoreria, asistcont, practcont, auxcont, audit] = depts;

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
        timezone: TZ,
        notificationPrefs: { create: { workspaceId: ws.id } },
      },
    });

  const director = await user('director@central.local', 'Directora General', 'ADMIN', null);
  const jefeMkt = await user('jefe.marketing@central.local', 'Jefe Marketing', 'JEFE_AREA', marketing.id, true);
  const jefeCom = await user('jefe.community@central.local', 'Jefe Community', 'JEFE_AREA', community.id, true);
  const jefeDis = await user('jefe.diseno@central.local', 'Jefe Diseño', 'JEFE_AREA', diseno.id, true);
  const jefeFin = await user('jefe.finanzas@central.local', 'Jefe Finanzas', 'JEFE_AREA', finanzas.id, false);
  
  const ana = await user('ana.gomez@central.local', 'Ana Gómez', 'USER', marketing.id);
  const luis = await user('luis.perez@central.local', 'Luis Pérez', 'USER', community.id);
  const carla = await user('carla.ruiz@central.local', 'Carla Ruiz', 'USER', finanzas.id);
  const nora = await user('nora.nomina@central.local', 'Nora Nómina', 'USER', rhhnomina.id);
  
  await user('viewer@central.local', 'Lector', 'VIEWER', marketing.id);

  // Assign heads
  for (const d of [marketing, community, diseno, audiovisual, rhhnomina, rrhss, clima, finanzas, tesoreria, asistcont, practcont, auxcont, audit]) {
    const jefe = [jefeMkt, jefeCom, jefeDis, jefeMkt, jefeFin, jefeFin, jefeFin, jefeFin, jefeFin, jefeFin, jefeFin, jefeFin, jefeFin][depts.indexOf(d)];
    if (jefe) await prisma.department.update({ where: { id: d.id }, data: { headId: jefe.id } });
  }

  // Area definitions: KPIs, Functions, Weekly tasks
  const areas = [
    { dept: marketing, head: jefeMkt, kpis: [
      { title: 'Leads generados', type: 'RESULT' as const, target: 100, history: [92, 81, 97] },
      { title: 'Posts publicados', type: 'COMPLIANCE' as const, target: 15, history: [15, 12, 16] },
    ], functions: [
      { title: 'Reunión de equipo', frequency: 'WEEKLY' as const, history: ['YES', 'YES', 'YES'] },
      { title: '1:1 con dirección', frequency: 'WEEKLY' as const, history: ['PARTIAL', 'YES', 'PARTIAL'] },
    ], weekly: ['Planificar contenidos', 'Responder mensajes'], people: [ana.id] },
    { dept: community, head: jefeCom, kpis: [
      { title: 'Respuestas a comentarios', type: 'COMPLIANCE' as const, target: 20, history: [18, 20, 19] },
      { title: 'Engagement rate %', type: 'RESULT' as const, target: 5, history: [4.2, 5.1, 4.8] },
    ], functions: [
      { title: 'Monitoreo diario', frequency: 'DAILY' as const, history: ['YES', 'YES', 'YES'] },
    ], weekly: ['Reportar estado', 'Planificar eventos'], people: [luis.id] },
    { dept: diseno, head: jefeDis, kpis: [
      { title: 'Diseños entregados', type: 'COMPLIANCE' as const, target: 10, history: [9, 10, 8] },
    ], functions: [
      { title: 'Revisión de proyecto', frequency: 'WEEKLY' as const, history: ['YES', 'PARTIAL', 'YES'] },
    ], weekly: ['Revisar briefs', 'Enviar entregas'], people: [ana.id, luis.id] },
    { dept: finanzas, head: jefeFin, kpis: [
      { title: 'Recaudos S/', type: 'RESULT' as const, unit: 'mil', target: 50, history: [48, 52, 44] },
      { title: 'Días de cierre', type: 'RESULT' as const, target: 3, lesserIsBetter: true, history: [3, 4, 5] },
    ], functions: [
      { title: 'Conciliación', frequency: 'WEEKLY' as const, history: ['YES', 'YES', 'PARTIAL'] },
      { title: 'Arqueo diario', frequency: 'DAILY' as const, history: ['YES', 'YES', 'YES'] },
    ], weekly: ['Registrar facturas', 'Actualizar flujo'], people: [carla.id] },
    { dept: rhhnomina, head: jefeFin, kpis: [
      { title: 'Tardanzas', type: 'RESULT' as const, target: 5, lesserIsBetter: true, history: [4, 7, 6] },
      { title: 'Nóminas a tiempo %', type: 'COMPLIANCE' as const, target: 100, history: [100, 100, 90] },
    ], functions: [
      { title: 'Control asistencia', frequency: 'DAILY' as const, history: ['YES', 'PARTIAL', 'YES'] },
    ], weekly: ['Consolidar marcaciones', 'Calcular extra'], people: [nora.id] },
    { dept: tesoreria, head: jefeFin, kpis: [
      { title: 'Pagos procesados', type: 'COMPLIANCE' as const, target: 100, history: [98, 100, 95] },
    ], functions: [
      { title: 'Pago a proveedores', frequency: 'WEEKLY' as const, history: ['YES', 'PARTIAL', 'NO'] },
    ], weekly: ['Procesar pagos'], people: [carla.id] },
    { dept: audit, head: jefeFin, kpis: [
      { title: 'Auditorías completadas', type: 'COMPLIANCE' as const, target: 5, history: [4, 5, 3] },
    ], functions: [
      { title: 'Reporte de hallazgos', frequency: 'WEEKLY' as const, history: ['YES', 'YES', 'PARTIAL'] },
    ], weekly: ['Revisar procedimientos'], people: [carla.id] },
  ];

  const now = new Date();
  const currentMonday = mondayOf(now, TZ);

  const createWeek = async (monday: string) =>
    prisma.week.create({ data: { workspaceId: ws.id, mondayDate: dayToDate(monday), ...isoWeek(monday), createdById: director.id } });

  const addDefinitions = async (weekId: string, historyIndex: number | null) => {
    for (const a of areas) {
      await prisma.kpi.createMany({
        data: a.kpis.map((k, order) => ({
          workspaceId: ws.id,
          weekId,
          departmentId: a.dept.id,
          title: k.title,
          type: k.type,
          unit: k.unit ?? null,
          target: new Prisma.Decimal(k.target),
          lesserIsBetter: k.lesserIsBetter ?? false,
          order,
          actual: historyIndex === null ? null : new Prisma.Decimal(k.history[historyIndex]!),
          recordedAt: historyIndex === null ? null : now,
          recordedById: historyIndex === null ? null : a.head?.id,
          createdById: a.head?.id ?? director.id,
        })),
      });
      await prisma.departmentFunction.createMany({
        data: a.functions.map((f, order) => ({
          workspaceId: ws.id,
          weekId,
          departmentId: a.dept.id,
          title: f.title,
          frequency: f.frequency,
          order,
          fulfilled: historyIndex === null ? null : f.history[historyIndex]!,
          markedAt: historyIndex === null ? null : now,
          createdById: a.head?.id ?? director.id,
        })),
      });
    }
  };

  const createTask = (weekId: string, monday: string, departmentId: string, by: string, t: TaskSeed) => {
    const status: TaskStatus = t.status ?? (t.progress === 100 ? 'DONE' : t.progress > 0 ? 'IN_PROGRESS' : 'TODO');
    const due = at(addDays(monday, t.day));
    return prisma.task.create({
      data: {
        workspaceId: ws.id,
        departmentId,
        weekId,
        assignedToId: t.to,
        createdById: by,
        title: t.title,
        status,
        priority: t.priority ?? 'MEDIUM',
        progress: t.progress,
        dueDate: due,
        blockReason: t.blockReason ?? null,
        blockedSince: t.blockReason ? now : null,
        blockedByUserId: t.blockReason ? t.to : null,
        wasBlocked: !!t.blockReason,
        actualStartDate: t.progress > 0 ? due : null,
        actualCompletionDate: status === 'DONE' ? due : null,
        collaborationParticipantIds: [by, ...(t.to ? [t.to] : [])],
        ...(t.observation ? { observations: { create: { workspaceId: ws.id, weekId, observation: t.observation, createdById: t.to ?? by } } } : {}),
      },
    });
  };

  // Closed weeks with history
  const PROGRESS_PATTERN = [[100, 100, 75, 100], [100, 50, 100, 75], [100, 100, 100, 25]];
  let lastClosed: { id: string; monday: string } | null = null;
  for (let i = HISTORY_WEEKS; i >= 1; i--) {
    const monday = addDays(currentMonday, -7 * i);
    const week = await createWeek(monday);
    const h = HISTORY_WEEKS - i;
    await addDefinitions(week.id, h);
    for (const a of areas) {
      for (const [n, title] of a.weekly.entries()) {
        await createTask(week.id, monday, a.dept.id, a.head?.id ?? director.id, {
          title,
          day: Math.min(n + 1, 5),
          to: a.people[n % a.people.length]!,
          progress: PROGRESS_PATTERN[h]![n % 4]!,
        });
      }
    }
    const snapshot = await buildWeekData(prisma, week, TZ, null, new Date(`${saturdayOf(monday)}T23:00:00.000Z`));
    snapshot.week.status = 'ARCHIVED';
    await prisma.weeklyArchive.create({
      data: {
        workspaceId: ws.id,
        weekId: week.id,
        weekStart: week.mondayDate,
        weekEnd: dayToDate(saturdayOf(monday)),
        data: snapshot as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.week.update({ where: { id: week.id }, data: { status: 'ARCHIVED', archivedAt: now, archivedById: director.id } });
    lastClosed = { id: week.id, monday };
  }

  // Current week
  const current = await createWeek(currentMonday);
  await addDefinitions(current.id, null);
  const thisWeek: { dept: string; by: string; tasks: TaskSeed[] }[] = [
    { dept: marketing.id, by: jefeMkt.id, tasks: [
      { title: 'Revisar briefing campañas', day: 0, to: ana.id, progress: 100 },
      { title: 'Publicar 5 posts', day: 1, to: ana.id, progress: 75, priority: 'HIGH' },
      { title: 'Aprobar pauta Meta Ads', day: 2, to: ana.id, progress: 50, status: 'BLOCKED', priority: 'URGENT', blockReason: 'Esperando presupuesto' },
      { title: 'Brief diseño', day: 3, to: luis.id, progress: 25 },
    ] },
    { dept: community.id, by: jefeCom.id, tasks: [
      { title: 'Responder comentarios', day: 0, to: luis.id, progress: 100 },
      { title: 'Reportar engagement', day: 5, to: luis.id, progress: 50 },
    ] },
    { dept: finanzas.id, by: jefeFin.id, tasks: [
      { title: 'Cierre de caja', day: 0, to: carla.id, progress: 100 },
      { title: 'Conciliación bancaria', day: 1, to: carla.id, progress: 50, priority: 'HIGH' },
      { title: 'Flujo de caja Q4', day: 3, to: jefeFin.id, progress: 75, priority: 'URGENT' },
    ] },
  ];
  
  let taskCount = 0;
  for (const area of thisWeek) {
    for (const t of area.tasks) {
      await createTask(current.id, currentMonday, area.dept, area.by, t);
      taskCount++;
    }
  }

  if (lastClosed) {
    const carried = await prisma.task.findFirst({ where: { weekId: lastClosed.id, progress: { lt: 100 } } });
    if (carried) await prisma.task.update({ where: { id: carried.id }, data: { weekId: current.id, carriedFromWeekId: lastClosed.id } });
  }

  console.log(
    `✅ Seeded "${ws.name}": ${HISTORY_WEEKS} closed weeks + week ${current.weekNumber} with ${taskCount} tasks.`,
  );
  console.log(`🔑 Password: ${DEMO_PASSWORD}`);
  console.log(`👥 Accounts: director@, jefe.* (various departments), ana@, luis@, carla@, nora@, viewer@ — all @central.local`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
