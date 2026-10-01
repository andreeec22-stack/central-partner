import { TZDate } from '@date-fns/tz';
import type { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { contentDisposition } from '../../lib/storage';
import { addDays } from '../../lib/week';
import { parseQuery } from '../../lib/validation';
import { requireAuth, requireRole } from '../../middleware/auth';
import type { AppEnv, AuthUser } from '../../types';

// Auditoría: the append-only activity log, filterable and exportable. ADMIN only.

export const ACTION_LABEL: Record<string, string> = {
  WORKSPACE_CREATED: 'Creó el espacio de trabajo',
  USER_REGISTERED: 'Se registró',
  USER_LOGGED_IN: 'Inició sesión',
  USER_LOGGED_OUT: 'Cerró sesión',
  PASSWORD_RESET_REQUESTED: 'Pidió restablecer contraseña',
  PASSWORD_RESET_COMPLETED: 'Restableció su contraseña',
  REFRESH_TOKEN_REUSE_DETECTED: 'Reuso de sesión detectado',
  DEPARTMENT_CREATED: 'Creó departamento',
  DEPARTMENT_UPDATED: 'Actualizó departamento',
  DEPARTMENT_DELETED: 'Desactivó departamento',
  USER_INVITED: 'Invitó usuario',
  INVITATION_ACCEPTED: 'Aceptó invitación',
  USER_UPDATED: 'Actualizó usuario',
  USER_DELETED: 'Desactivó usuario',
  USER_RESTORED: 'Reactivó usuario',
  NOTIFICATION_PREFERENCES_UPDATED: 'Cambió notificaciones',
  TASK_CREATED: 'Creó tarea',
  TASK_UPDATED: 'Actualizó tarea',
  TASK_BLOCKED: 'Bloqueó tarea',
  TASK_UNBLOCKED: 'Desbloqueó tarea',
  TASK_COMPLETED: 'Completó tarea',
  TASK_DELETED: 'Eliminó tarea',
  TASK_DEPENDENCY_ADDED: 'Añadió dependencia',
  TASK_DEPENDENCY_REMOVED: 'Quitó dependencia',
  TASKS_IMPORTED: 'Importó tareas',
  COMMENT_ADDED: 'Comentó',
  COMMENT_EDITED: 'Editó comentario',
  COMMENT_DELETED: 'Borró comentario',
  FILE_UPLOADED: 'Subió archivo',
  FILE_DELETED: 'Eliminó archivo',
  EXCEL_IMPORT_UPLOADED: 'Subió Excel',
  EXCEL_IMPORT_CONFIRMED: 'Confirmó importación',
  BRANDING_UPDATED: 'Cambió la marca',
  BRANDING_LOGO_UPDATED: 'Cambió el logo',
  WEEK_CREATED: 'Abrió semana',
  WEEK_CLOSED: 'Cerró semana',
  KPI_CREATED: 'Creó KPI',
  KPI_UPDATED: 'Actualizó KPI',
  KPI_RECORDED: 'Registró resultado de KPI',
  KPI_DELETED: 'Eliminó KPI',
  FUNCTION_CREATED: 'Creó función',
  FUNCTION_UPDATED: 'Actualizó función',
  FUNCTION_MARKED: 'Marcó función',
  FUNCTION_DELETED: 'Eliminó función',
  TASK_OBSERVATION_SET: 'Escribió observación',
  WORKSPACE_SETTINGS_UPDATED: 'Cambió la configuración',
  PERMISSIONS_UPDATED: 'Cambió permisos',
  SURVEY_TEMPLATE_CREATED: 'Creó plantilla de encuesta',
  SURVEY_TEMPLATE_UPDATED: 'Actualizó plantilla de encuesta',
  SURVEY_TEMPLATE_DELETED: 'Eliminó plantilla de encuesta',
  SURVEY_CREATED: 'Creó evaluación',
  SURVEY_CREATED_WITHOUT_PRODUCTIVITY: 'Evaluación sin índice de productividad',
  SURVEY_SUBMITTED: 'Envió evaluación',
  SURVEY_RESPONSES_CORRECTED: 'Corrigió respuestas de evaluación',
  SURVEY_CANCELLED: 'Canceló evaluación',
  PERFORMANCE_REVIEW_UPDATED: 'Editó resultado de desempeño',
  PERFORMANCE_REVIEW_PUBLISHED: 'Publicó resultado de desempeño',
  PERFORMANCE_REVIEW_RECALCULATED: 'Resultado publicado recalculado',
  OKR_CREATED: 'Creó objetivo',
  OKR_UPDATED: 'Editó objetivo',
  OKR_DELETED: 'Eliminó objetivo',
  OKR_CHECKED_IN: 'Registró avance de objetivo',
};

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const filtersSchema = z.object({
  userId: z.string().uuid().optional(),
  action: z
    .string()
    .max(500)
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^[A-Z_]{2,64}$/)).min(1))
    .optional(),
  entityType: z.string().regex(/^[A-Za-z]{1,64}$/).optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  search: z.string().trim().min(1).max(100).optional(),
});
type Filters = z.infer<typeof filtersSchema>;

const listSchema = filtersSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

// Days are calendar days in the workspace timezone: local midnight as an instant.
function dayStart(day: string, timeZone: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(new TZDate(y!, m! - 1, d!, 0, 0, 0, timeZone).getTime());
}

function whereFor(user: AuthUser, f: Filters): Prisma.ActivityLogWhereInput {
  const search = f.search;
  return {
    workspaceId: user.workspaceId,
    ...(f.userId ? { userId: f.userId } : {}),
    ...(f.action ? { action: { in: f.action } } : {}),
    ...(f.entityType ? { entityType: f.entityType } : {}),
    ...(f.from || f.to
      ? {
          createdAt: {
            ...(f.from ? { gte: dayStart(f.from, user.workspaceTimezone) } : {}),
            ...(f.to ? { lt: dayStart(addDays(f.to, 1), user.workspaceTimezone) } : {}),
          },
        }
      : {}),
    ...(search
      ? {
          OR: [
            { user: { displayName: { contains: search, mode: 'insensitive' } } },
            { user: { email: { contains: search, mode: 'insensitive' } } },
            { action: { contains: search.toUpperCase().replace(/\s+/g, '_') } },
            // Actions by their Spanish label ("cerró semana").
            ...(() => {
              const s = search.toLowerCase();
              const actions = Object.entries(ACTION_LABEL)
                .filter(([, label]) => label.toLowerCase().includes(s))
                .map(([a]) => a);
              return actions.length ? [{ action: { in: actions } }] : [];
            })(),
          ],
        }
      : {}),
  };
}

// A readable name for what was touched, from whatever the log kept.
function entityLabel(metadata: Prisma.JsonValue | null, changes: Prisma.JsonValue | null): string | null {
  // A creation logs the new values as changes: { title: { old: null, new: "…" } }.
  const created = changes && typeof changes === 'object' && !Array.isArray(changes) ? (changes as Record<string, { new?: unknown }>) : null;
  if (typeof created?.title?.new === 'string') return created.title.new;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const m = metadata as Record<string, unknown>;
  for (const key of ['title', 'displayName', 'email', 'filename', 'name', 'excerpt']) {
    if (typeof m[key] === 'string' && m[key]) return m[key] as string;
  }
  if (typeof m.weekNumber === 'number') return `Semana ${m.weekNumber}`;
  if (typeof m.mondayDate === 'string') return `Semana del ${m.mondayDate}`;
  return null;
}

const include = { user: { select: { id: true, displayName: true, email: true } } } satisfies Prisma.ActivityLogInclude;
type Row = Prisma.ActivityLogGetPayload<{ include: typeof include }>;

function present(r: Row) {
  return {
    id: r.id,
    timestamp: r.createdAt,
    action: r.action,
    actionLabel: ACTION_LABEL[r.action] ?? r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    entityLabel: entityLabel(r.metadata, r.changes),
    user: r.user ? { id: r.user.id, name: r.user.displayName, email: r.user.email } : null,
    changes: r.changes,
    metadata: r.metadata,
    ipAddress: r.ipAddress,
  };
}

export const EXPORT_LIMIT = 10_000;

// Spreadsheet apps execute cells starting with = + - @ as formulas.
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportRows(user: AuthUser, rows: Row[]) {
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'short', timeStyle: 'medium', timeZone: user.workspaceTimezone });
  return rows.map((r) => {
    const p = present(r);
    return {
      Fecha: fmt.format(r.createdAt),
      Usuario: p.user?.name ?? 'Sistema',
      Email: p.user?.email ?? '',
      Acción: p.actionLabel,
      Código: r.action,
      Entidad: r.entityType,
      Detalle: p.entityLabel ?? '',
      Cambios: r.changes ? JSON.stringify(r.changes) : '',
      IP: r.ipAddress ?? '',
    };
  });
}

export const auditRoutes = new Hono<AppEnv>()
  .use('*', requireAuth, requireRole('ADMIN'))
  .get('/', async (c) => {
    const user = c.get('user');
    const q = parseQuery(c, listSchema);
    const where = whereFor(user, q);
    const [rows, total] = await Promise.all([
      prisma.activityLog.findMany({ where, include, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
      prisma.activityLog.count({ where }),
    ]);
    return c.json({ data: rows.map(present), total, page: q.page, limit: q.limit });
  })
  .get('/export', async (c) => {
    const user = c.get('user');
    const q = parseQuery(c, filtersSchema.extend({ format: z.enum(['csv', 'xlsx']).default('csv') }));
    const rows = await prisma.activityLog.findMany({
      where: whereFor(user, q),
      include,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: EXPORT_LIMIT,
    });
    const data = exportRows(user, rows);
    const stamp = new Date().toISOString().slice(0, 10);
    const headers = ['Fecha', 'Usuario', 'Email', 'Acción', 'Código', 'Entidad', 'Detalle', 'Cambios', 'IP'] as const;

    if (q.format === 'csv') {
      const lines = [headers.join(','), ...data.map((r) => headers.map((h) => csvCell(r[h])).join(','))];
      // BOM so Excel opens the accents correctly.
      return c.body(`﻿${lines.join('\r\n')}\r\n`, 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': contentDisposition('attachment', `auditoria-${stamp}.csv`),
        'Cache-Control': 'no-store',
      });
    }

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Auditoría');
    sheet.columns = headers.map((h) => ({ header: h, key: h, width: h === 'Cambios' ? 60 : h === 'Detalle' ? 36 : 18 }));
    // exceljs writes values as data, never formulas — no injection risk here.
    data.forEach((r) => sheet.addRow(r));
    const head = sheet.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4B5563' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    return c.body(new Uint8Array(await wb.xlsx.writeBuffer()), 200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': contentDisposition('attachment', `auditoria-${stamp}.xlsx`),
      'Cache-Control': 'no-store',
    });
  });

