import type { Priority } from '@prisma/client';

// Turns spreadsheet rows into task suggestions. Pure: no I/O, fully unit-tested.
//
// If the first non-empty row looks like a header ("Tarea | Área | Responsable…")
// columns are mapped by name. Otherwise the first non-empty cell is the title
// and every other cell is scanned for a department, a person, a priority or a
// status. Matching is accent- and case-insensitive with a little fuzziness.
//
// confidence = 0.4·title + 0.3·department + 0.3·assignee, each part weighted
// by how exact its match was.

export type ImportStatus = 'TODO' | 'IN_PROGRESS' | 'DONE';

export interface DeptRef {
  id: string;
  name: string;
}

export interface UserRef {
  id: string;
  displayName: string;
  email: string;
  departmentId: string | null;
}

export interface DetectedTask {
  rowIndex: number; // 0-based index into the sheet's rows
  title: string;
  description?: string;
  departmentId?: string;
  departmentName?: string;
  assigneeId?: string;
  assigneeName?: string;
  priority: Priority;
  status: ImportStatus;
  kpiTarget?: string;
  dueDate?: string; // ISO date
  confidence: number;
}

export interface DetectionResult {
  detectedTasks: DetectedTask[];
  unmappedRows: { rowIndex: number; reason: string }[];
  totalRowsCount: number;
  mappingLog: {
    headerRowIndex: number | null;
    columns: Partial<Record<Field, number>>;
    departmentsMatched: number;
    assigneesMatched: number;
    departmentsInferredFromAssignee: number;
  };
}

type Field = 'title' | 'description' | 'department' | 'assignee' | 'priority' | 'status' | 'kpi' | 'dueDate';

export const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9@.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const HEADER_WORDS: Record<Field, string[]> = {
  title: ['titulo', 'tarea', 'tareas', 'actividad', 'task', 'title', 'nombre', 'pendiente'],
  description: ['descripcion', 'detalle', 'detalles', 'notas', 'observaciones', 'description', 'notes'],
  department: ['departamento', 'area', 'department', 'dpto', 'depto', 'equipo'],
  assignee: ['responsable', 'asignado', 'asignado a', 'encargado', 'assignee', 'owner', 'persona'],
  priority: ['prioridad', 'priority', 'urgencia'],
  status: ['estado', 'status', 'situacion'],
  kpi: ['kpi', 'meta', 'objetivo', 'target', 'indicador'],
  dueDate: ['fecha', 'fecha limite', 'vencimiento', 'vence', 'due', 'due date', 'deadline', 'entrega', 'fecha entrega'],
};

function headerField(cell: string): Field | null {
  const n = normalize(cell);
  if (!n) return null;
  for (const [field, words] of Object.entries(HEADER_WORDS) as [Field, string[]][]) {
    if (words.includes(n)) return field;
  }
  for (const [field, words] of Object.entries(HEADER_WORDS) as [Field, string[]][]) {
    if (words.some((w) => w.length > 3 && n.startsWith(w))) return field;
  }
  return null;
}

// A row is a header when at least two cells name known columns, one being the title.
function detectHeader(row: string[]): Partial<Record<Field, number>> | null {
  const columns: Partial<Record<Field, number>> = {};
  row.forEach((cell, i) => {
    const field = headerField(cell);
    if (field && columns[field] === undefined) columns[field] = i;
  });
  return Object.keys(columns).length >= 2 && columns.title !== undefined ? columns : null;
}

const PRIORITY_WORDS: [Priority, string[]][] = [
  ['URGENT', ['urgente', 'urgent', 'critica', 'critico', 'critical', 'inmediato']],
  ['HIGH', ['alta', 'alto', 'high', 'importante']],
  ['LOW', ['baja', 'bajo', 'low']],
  ['MEDIUM', ['media', 'medio', 'medium', 'normal']],
];

const STATUS_WORDS: [ImportStatus, string[]][] = [
  ['DONE', ['hecho', 'hecha', 'terminado', 'terminada', 'completado', 'completada', 'done', 'listo', 'lista', 'finalizado', 'finalizada', '100%']],
  ['IN_PROGRESS', ['en progreso', 'en curso', 'en proceso', 'in progress', 'iniciado', 'iniciada', 'avanzando']],
  ['TODO', ['pendiente', 'por hacer', 'sin iniciar', 'todo', 'to do', 'no iniciado']],
];

const hasWord = (text: string, word: string) => new RegExp(`(^|\\s)${word.replace(/[.*+?^${}()|[\]\\%]/g, '\\$&')}($|\\s)`).test(text);

export function detectPriority(text: string): Priority | null {
  const n = normalize(text);
  for (const [p, words] of PRIORITY_WORDS) if (words.some((w) => hasWord(n, w))) return p;
  return null;
}

export function detectStatus(text: string): ImportStatus | null {
  const n = normalize(text.replace('100%', ' 100% '));
  for (const [s, words] of STATUS_WORDS) if (words.some((w) => (w === '100%' ? text.includes('100%') : hasWord(n, w)))) return s;
  return null;
}

const tokens = (s: string) => new Set(normalize(s).split(' ').filter((t) => t.length > 2));

function tokenOverlap(a: string, b: string) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

// 1 = exact, 0.8 = one contains the other, 0.6 = most words shared.
export function matchDepartment(cell: string, departments: DeptRef[]): { dept: DeptRef; score: number } | null {
  const n = normalize(cell);
  if (!n) return null;
  let best: { dept: DeptRef; score: number } | null = null;
  for (const dept of departments) {
    const d = normalize(dept.name);
    let score = 0;
    if (n === d) score = 1;
    else if ((d.length >= 3 && hasWord(n, d)) || (n.length >= 3 && hasWord(d, n))) score = 0.8;
    else if (tokenOverlap(n, d) >= 0.5) score = 0.6;
    if (score > (best?.score ?? 0)) best = { dept, score };
  }
  return best;
}

// 1 = full name, 0.9 = email or its local part, 0.7 = a first name only one person has.
export function matchUser(cell: string, users: UserRef[]): { user: UserRef; score: number } | null {
  const n = normalize(cell);
  if (!n) return null;
  let best: { user: UserRef; score: number } | null = null;
  const consider = (user: UserRef, score: number) => {
    if (score > (best?.score ?? 0)) best = { user, score };
  };
  for (const user of users) {
    const name = normalize(user.displayName);
    const email = user.email.toLowerCase();
    if (n === name || (name.length > 4 && hasWord(n, name))) consider(user, 1);
    else if (n === email || hasWord(n, email) || n === email.split('@')[0]) consider(user, 0.9);
  }
  if (best) return best;
  const firstNames = new Map<string, UserRef[]>();
  for (const user of users) {
    const first = normalize(user.displayName).split(' ')[0];
    if (first && first.length > 2) firstNames.set(first, [...(firstNames.get(first) ?? []), user]);
  }
  for (const [first, owners] of firstNames) {
    if (owners.length === 1 && (n === first || hasWord(n, first))) consider(owners[0]!, 0.7);
  }
  return best;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Excel dates arrive as ISO strings (from Date cells) or as text like 15/10/2026.
export function parseDate(text: string): string | undefined {
  const t = text.trim();
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (dmy) {
    const year = dmy[3]!.length === 2 ? `20${dmy[3]}` : dmy[3]!;
    const month = Number(dmy[2]);
    const day = Number(dmy[1]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return undefined;
}

export function detectTasks(rows: string[][], departments: DeptRef[], users: UserRef[]): DetectionResult {
  const clean = rows.map((r) => r.map((c) => (c ?? '').toString().trim()));
  const firstNonEmpty = clean.findIndex((r) => r.some(Boolean));
  const columns = firstNonEmpty >= 0 ? detectHeader(clean[firstNonEmpty]!) : null;
  const headerRowIndex = columns ? firstNonEmpty : null;

  const detectedTasks: DetectedTask[] = [];
  const unmappedRows: DetectionResult['unmappedRows'] = [];
  const log = { departmentsMatched: 0, assigneesMatched: 0, departmentsInferredFromAssignee: 0 };
  let totalRowsCount = 0;

  clean.forEach((row, rowIndex) => {
    if (rowIndex === headerRowIndex || !row.some(Boolean)) return;
    totalRowsCount++;
    const at = (field: Field) => (columns?.[field] !== undefined ? (row[columns[field]!] ?? '') : '');

    let title: string;
    let rest: string[];
    if (columns) {
      title = at('title');
      rest = [];
    } else {
      const titleIndex = row.findIndex(Boolean);
      title = row[titleIndex]!;
      rest = row.filter((c, i) => i !== titleIndex && c);
    }
    title = title.replace(/\s+/g, ' ').trim().slice(0, 255);
    if (!title) {
      unmappedRows.push({ rowIndex, reason: 'No title found' });
      return;
    }

    const deptMatch = columns
      ? matchDepartment(at('department'), departments)
      : rest.map((c) => matchDepartment(c, departments)).reduce<ReturnType<typeof matchDepartment>>((a, b) => ((b?.score ?? 0) > (a?.score ?? 0) ? b : a), null);
    // Prefer people from the matched department when names are ambiguous.
    const pool = deptMatch ? [...users.filter((u) => u.departmentId === deptMatch.dept.id), ...users.filter((u) => u.departmentId !== deptMatch.dept.id)] : users;
    const userMatch = columns
      ? matchUser(at('assignee'), pool)
      : rest
          .map((c) => matchUser(c, pool))
          .reduce<ReturnType<typeof matchUser>>((a, b) => ((b?.score ?? 0) > (a?.score ?? 0) ? b : a), null);

    // Last resort: a department named inside the title ("Nómina — cierre RRHH").
    const titleDept = deptMatch ? null : matchDepartment(title, departments);
    let department = deptMatch?.dept ?? (titleDept && titleDept.score >= 0.8 ? titleDept.dept : undefined);
    let deptScore = deptMatch?.score ?? (department ? 0.6 : 0);
    if (!department && userMatch?.user.departmentId) {
      department = departments.find((d) => d.id === userMatch.user.departmentId);
      if (department) {
        deptScore = 0.7;
        log.departmentsInferredFromAssignee++;
      }
    } else if (department) log.departmentsMatched++;
    if (userMatch) log.assigneesMatched++;

    const scanText = columns ? `${at('priority')} ${at('status')}` : row.join(' ');
    const priority = (columns ? detectPriority(at('priority')) : null) ?? detectPriority(scanText) ?? 'MEDIUM';
    const status = (columns ? detectStatus(at('status')) : null) ?? (columns ? null : detectStatus(rest.join(' '))) ?? 'TODO';

    const task: DetectedTask = {
      rowIndex,
      title,
      priority,
      status,
      confidence: round2(0.4 + 0.3 * deptScore + 0.3 * (userMatch?.score ?? 0)),
    };
    const description = at('description');
    if (description) task.description = description.slice(0, 10_000);
    if (department) {
      task.departmentId = department.id;
      task.departmentName = department.name;
    }
    if (userMatch) {
      task.assigneeId = userMatch.user.id;
      task.assigneeName = userMatch.user.displayName;
    }
    const kpi = at('kpi');
    if (kpi) task.kpiTarget = kpi.slice(0, 255);
    const due = parseDate(at('dueDate'));
    if (due) task.dueDate = due;
    detectedTasks.push(task);
  });

  return { detectedTasks, unmappedRows, totalRowsCount, mappingLog: { headerRowIndex, columns: columns ?? {}, ...log } };
}
