import ExcelJS from 'exceljs';
import { prisma } from '../../src/lib/prisma';
import { setStorage } from '../../src/lib/storage';
import { createTask, seedWorkspace, type Seed } from './fixtures';
import { call, MemoryStorage, resetDatabase, upload } from './helpers';

let s: Seed;

beforeEach(async () => {
  await resetDatabase();
  setStorage(new MemoryStorage());
  s = await seedWorkspace();
  await prisma.department.update({ where: { id: s.marketing }, data: { headId: s.mkt.jefe.id } });
});
afterAll(() => setStorage(null));

async function workbook(rows: unknown[][]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Tareas');
  rows.forEach((r) => sheet.addRow(r));
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

const uploadSheet = async (rows: unknown[][], token = s.admin.token) =>
  upload('/api/v1/excel-imports/upload', token, 'semana.xlsx', await workbook(rows));

describe('excel imports', () => {
  it('detects tasks from a sheet with headers, then creates the confirmed ones', async () => {
    await createTask(s.mkt.jefe.token, { title: 'Informe de leads' });
    const res = await uploadSheet([
      ['Tarea', 'Área', 'Responsable', 'Prioridad', 'Estado', 'KPI'],
      ['Publicar posts de octubre', 'Marketing', 'ana.mkt', 'Alta', 'En progreso', '5 posts'],
      ['Conciliación bancaria', 'finanzas', 'carla.fin', 'urgente', '', ''],
      ['Informe de leads', 'Marketing', '', '', 'hecho', ''],
      ['', 'Marketing', '', '', '', ''],
    ]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'PENDING', totalRowsCount: 4, unmappedRowsCount: 1 });
    const [posts, conciliacion, leads] = res.body.detectedTasks;
    expect(posts).toMatchObject({
      rowIndex: 1,
      title: 'Publicar posts de octubre',
      departmentId: s.marketing,
      assigneeId: s.mkt.user.id,
      priority: 'HIGH',
      status: 'IN_PROGRESS',
      kpiTarget: '5 posts',
    });
    expect(posts.confidence).toBeGreaterThanOrEqual(0.9);
    expect(conciliacion).toMatchObject({ departmentId: s.finanzas, assigneeId: s.fin.user.id, priority: 'URGENT' });
    expect(leads).toMatchObject({ status: 'DONE' });
    expect(leads.assigneeId).toBeUndefined();

    const confirm = await call('POST', `/api/v1/excel-imports/${res.body.importId}/confirm`, {
      token: s.admin.token,
      body: {
        taskMappings: [
          { rowIndex: 1, title: posts.title, departmentId: s.marketing, assignedToId: s.mkt.user.id, priority: 'HIGH', status: 'IN_PROGRESS' },
          { rowIndex: 2, title: conciliacion.title, departmentId: s.finanzas, assignedToId: s.mkt.user.id }, // not in Finanzas
          { rowIndex: 3, title: 'informe de LEADS', departmentId: s.marketing }, // already exists
        ],
      },
    });
    expect(confirm.status).toBe(200);
    expect(confirm.body).toEqual({
      createdCount: 1,
      skippedCount: 2,
      skippedDetails: [
        { rowIndex: 2, reason: "Assignee is not an active member of the task's department" },
        { rowIndex: 3, reason: 'Duplicate task in department' },
      ],
    });
    const created = await prisma.task.findFirstOrThrow({ where: { sourceType: 'EXCEL_IMPORT' } });
    expect(created).toMatchObject({ title: 'Publicar posts de octubre', excelImportId: res.body.importId, createdById: s.admin.id, status: 'IN_PROGRESS' });
    expect(await prisma.notification.count({ where: { userId: s.mkt.user.id, type: 'TASK_ASSIGNED' } })).toBe(1);

    // A confirmed import can't be confirmed again.
    const again = await call('POST', `/api/v1/excel-imports/${res.body.importId}/confirm`, {
      token: s.admin.token,
      body: { taskMappings: [{ rowIndex: 1, title: 'Otra', departmentId: s.marketing }] },
    });
    expect(again.status).toBe(409);

    const detail = await call('GET', `/api/v1/excel-imports/${res.body.importId}`, { token: s.admin.token });
    expect(detail.body.import).toMatchObject({ status: 'COMPLETED', createdCount: 1, skippedCount: 2, totalRows: 4 });
    const list = await call('GET', '/api/v1/excel-imports', { token: s.admin.token });
    expect(list.body.data).toHaveLength(1);
  });

  it('assigns the department head when no assignee is given', async () => {
    const res = await uploadSheet([['Preparar reportaje de temporada Marketing']]);
    const [task] = res.body.detectedTasks;
    expect(task).toMatchObject({ title: 'Preparar reportaje de temporada Marketing', departmentId: s.marketing });
    await call('POST', `/api/v1/excel-imports/${res.body.importId}/confirm`, {
      token: s.admin.token,
      body: { taskMappings: [{ rowIndex: 0, title: task.title, departmentId: s.marketing }] },
    });
    expect((await prisma.task.findFirstOrThrow({ where: { sourceType: 'EXCEL_IMPORT' } })).assignedToId).toBe(s.mkt.jefe.id);
  });

  it('is ADMIN-only and validates the file', async () => {
    expect((await uploadSheet([['Tarea']], s.mkt.jefe.token)).status).toBe(403);
    const csv = await upload('/api/v1/excel-imports/upload', s.admin.token, 'datos.csv', new TextEncoder().encode('a,b'));
    expect(csv.status).toBe(422);
    const fake = await upload('/api/v1/excel-imports/upload', s.admin.token, 'datos.xlsx', new TextEncoder().encode('not a zip'));
    expect(fake.status).toBe(422);
    const tooMany = await uploadSheet(Array.from({ length: 1002 }, (_, i) => [`Tarea ${i}`]));
    expect(tooMany.status).toBe(422);
    expect((await prisma.excelImport.findFirstOrThrow({ where: { status: 'FAILED' } })).errorMessage).toContain('at most 1000 rows');
  });

  it('allows at most 5 imports waiting for review', async () => {
    for (let i = 0; i < 5; i++) expect((await uploadSheet([[`Tarea ${i}`]])).status).toBe(201);
    const sixth = await uploadSheet([['Tarea 6']]);
    expect(sixth.status).toBe(409);
    expect(sixth.body.error.code).toBe('TOO_MANY_OPEN_IMPORTS');
  });
});
