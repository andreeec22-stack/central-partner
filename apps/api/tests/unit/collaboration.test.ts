import { detectFileType, isSafeSvg, safeFilename, TASK_FILE_TYPES } from '../../src/lib/file-types';
import { isQuietTime } from '../../src/lib/quiet-hours';
import { detectPriority, detectStatus, detectTasks, matchDepartment, matchUser, parseDate } from '../../src/modules/excel-imports/detection';
import { assignHandles, extractMentions, resolveMentions } from '../../src/modules/tasks/mentions';

describe('mentions', () => {
  it('extracts handles, ignoring emails and trailing punctuation', () => {
    expect(extractMentions('Listo @juan, revisa @ana.gomez. Escribe a pedro@empresa.com o @Luis@otra.com!')).toEqual([
      'juan',
      'ana.gomez',
      'luis@otra.com',
    ]);
    expect(extractMentions('sin menciones')).toEqual([]);
    expect(extractMentions('@a @a @A')).toEqual(['a']);
  });

  it('uses the email local part, or the full email when it is ambiguous', () => {
    const people = assignHandles([
      { id: '1', email: 'ana@a.com', displayName: 'Ana A', role: 'USER', departmentId: null },
      { id: '2', email: 'ana@b.com', displayName: 'Ana B', role: 'USER', departmentId: null },
      { id: '3', email: 'Luis.Perez@a.com', displayName: 'Luis', role: 'USER', departmentId: null },
    ]);
    expect(people.map((p) => p.handle)).toEqual(['ana@a.com', 'ana@b.com', 'luis.perez']);
    expect(resolveMentions(['ana', 'ana@b.com', 'luis.perez'], people)).toEqual(['2', '3']);
  });
});

describe('quiet hours', () => {
  const at = (iso: string) => new Date(iso);
  it('blocks 21:00–07:00 in the recipient timezone', () => {
    expect(isQuietTime(at('2026-09-29T15:00:00Z'), 'America/Lima')).toBe(false); // 10:00
    expect(isQuietTime(at('2026-09-30T02:30:00Z'), 'America/Lima')).toBe(true); // 21:30
    expect(isQuietTime(at('2026-09-29T11:59:00Z'), 'America/Lima')).toBe(true); // 06:59
    expect(isQuietTime(at('2026-09-29T12:00:00Z'), 'America/Lima')).toBe(false); // 07:00
  });
  it('adds the user quiet window, which may wrap midnight', () => {
    expect(isQuietTime(at('2026-09-29T18:30:00Z'), 'America/Lima', '13:00', '14:00')).toBe(true); // 13:30
    expect(isQuietTime(at('2026-09-29T19:00:00Z'), 'America/Lima', '13:00', '14:00')).toBe(false); // 14:00
    expect(isQuietTime(at('2026-09-29T13:00:00Z'), 'America/Lima', '20:00', '09:00')).toBe(true); // 08:00
  });
});

describe('file types', () => {
  const pdf = new TextEncoder().encode('%PDF-1.7');
  it('needs both an allowed extension and matching content', () => {
    expect(detectFileType('a.PDF', pdf, TASK_FILE_TYPES)).toBe('application/pdf');
    expect(detectFileType('a.png', pdf, TASK_FILE_TYPES)).toBeNull();
    expect(detectFileType('a.exe', pdf, TASK_FILE_TYPES)).toBeNull();
    expect(detectFileType('noext', pdf, TASK_FILE_TYPES)).toBeNull();
  });
  it('flags active SVG content', () => {
    expect(isSafeSvg('<svg><rect/></svg>')).toBe(true);
    expect(isSafeSvg('<svg><use href="#a"/></svg>')).toBe(true);
    expect(isSafeSvg('<svg onload="x()"></svg>')).toBe(false);
    expect(isSafeSvg('<svg><a href="javascript:x()"/></svg>')).toBe(false);
    expect(isSafeSvg('<svg><image href="https://evil.test/x.png"/></svg>')).toBe(false);
  });
  it('makes storage-safe names', () => {
    expect(safeFilename('Informe Nómina (final).pdf')).toBe('Informe-Nomina-_final_.pdf');
    expect(safeFilename('../../etc/passwd')).toBe('_.._etc_passwd');
  });
});

describe('excel detection', () => {
  const depts = [
    { id: 'm', name: 'Marketing' },
    { id: 'r', name: 'RRHH - Nómina' },
  ];
  const users = [
    { id: 'u1', displayName: 'Ana Gómez', email: 'agomez@x.com', departmentId: 'm' },
    { id: 'u2', displayName: 'Luis Pérez', email: 'lperez@x.com', departmentId: 'r' },
  ];

  it('matches departments and people loosely', () => {
    expect(matchDepartment('MARKETING', depts)).toMatchObject({ dept: { id: 'm' }, score: 1 });
    expect(matchDepartment('nomina', depts)).toMatchObject({ dept: { id: 'r' }, score: 0.8 });
    expect(matchDepartment('Ventas', depts)).toBeNull();
    expect(matchUser('ana gomez', users)).toMatchObject({ user: { id: 'u1' }, score: 1 });
    expect(matchUser('lperez@x.com', users)).toMatchObject({ user: { id: 'u2' }, score: 0.9 });
    expect(matchUser('Ana', users)).toMatchObject({ user: { id: 'u1' }, score: 0.7 });
  });

  it('reads priorities, statuses and dates', () => {
    expect(detectPriority('¡URGENTE!')).toBe('URGENT');
    expect(detectPriority('prioridad alta')).toBe('HIGH');
    expect(detectPriority('nada')).toBeNull();
    expect(detectStatus('Terminado')).toBe('DONE');
    expect(detectStatus('en curso')).toBe('IN_PROGRESS');
    expect(parseDate('15/10/2026')).toBe('2026-10-15');
    expect(parseDate('2026-10-15')).toBe('2026-10-15');
    expect(parseDate('mañana')).toBeUndefined();
  });

  it('scores rows without headers and infers the department from the assignee', () => {
    const result = detectTasks(
      [
        ['Preparar reportaje', 'Marketing', 'Ana Gómez', 'urgente'],
        ['Liquidar quincena', 'Luis'],
        ['Algo sin contexto'],
        [],
      ],
      depts,
      users,
    );
    expect(result.mappingLog.headerRowIndex).toBeNull();
    expect(result.totalRowsCount).toBe(3);
    const [a, b, c] = result.detectedTasks;
    expect(a).toMatchObject({ title: 'Preparar reportaje', departmentId: 'm', assigneeId: 'u1', priority: 'URGENT', confidence: 1 });
    expect(b).toMatchObject({ departmentId: 'r', assigneeId: 'u2', confidence: 0.82 });
    expect(c).toMatchObject({ confidence: 0.4, priority: 'MEDIUM', status: 'TODO' });
    expect(result.mappingLog.departmentsInferredFromAssignee).toBe(1);
  });
});
