import clsx from 'clsx';
import { CircleCheck, FileSpreadsheet, TriangleAlert, Upload } from 'lucide-react';
import { useMemo, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router';
import { Button } from '../../components/ui/Button';
import { Skeleton } from '../../components/ui/Feedback';
import { ApiError, api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { PRIORITY_LABEL } from '../../lib/labels';
import {
  useConfirmImport,
  useDepartments,
  useDiscardImport,
  useImports,
  useUploadImport,
  useUsers,
  type ImportMapping,
} from '../../lib/queries';
import type { DetectedTask, ImportConfirmResult, ImportSummary, ImportTaskStatus, Priority } from '../../lib/types';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/toast';

const MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_ASSIGNEE = '__head';
const IMPORT_STATUS_LABEL: Record<ImportTaskStatus, string> = { TODO: 'Pendiente', IN_PROGRESS: 'En progreso', DONE: 'Completada' };
const SUMMARY_STATUS: Record<ImportSummary['status'], string> = {
  PROCESSING: 'Procesando',
  PENDING: 'Por revisar',
  COMPLETED: 'Importado',
  FAILED: 'Fallido',
};

interface Row {
  rowIndex: number;
  include: boolean;
  title: string;
  departmentId: string;
  assignee: string; // DEFAULT_ASSIGNEE | '' (nobody) | user id
  priority: Priority;
  status: ImportTaskStatus;
  kpiTarget: string;
  description?: string;
  dueDate?: string;
  confidence: number;
}

const toRow = (t: DetectedTask): Row => ({
  rowIndex: t.rowIndex,
  include: !!t.departmentId,
  title: t.title,
  departmentId: t.departmentId ?? '',
  assignee: t.assigneeId ?? DEFAULT_ASSIGNEE,
  priority: t.priority,
  status: t.status,
  kpiTarget: t.kpiTarget ?? '',
  description: t.description,
  dueDate: t.dueDate,
  confidence: t.confidence,
});

function Confidence({ value }: { value: number }) {
  const tone = value >= 0.8 ? 'bg-sem-green-soft text-sem-green' : value >= 0.6 ? 'bg-sem-yellow-soft text-sem-yellow' : 'bg-sem-red-soft text-sem-red';
  return (
    <span className={clsx('inline-block rounded-full px-2 py-0.5 font-mono text-xs font-semibold tabular', tone)} title="Qué tan seguro está el detector">
      {Math.round(value * 100)}%
    </span>
  );
}

// ─── Step 1: upload ─────────────────────────────────────────────────────────

function UploadStep({ onDetected }: { onDetected: (importId: string, tasks: DetectedTask[], unmapped: number, total: number) => void }) {
  const upload = useUploadImport();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const send = (file: File) => {
    if (!file.name.toLowerCase().endsWith('.xlsx')) return toast.error('Sube un archivo de Excel .xlsx');
    if (file.size > MAX_BYTES) return toast.error('El archivo no puede pesar más de 10 MB');
    upload.mutate(file, {
      onSuccess: (r) => onDetected(r.importId, r.detectedTasks, r.unmappedRowsCount, r.totalRowsCount),
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'No se pudo procesar el archivo'),
    });
  };

  return (
    <div
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) send(f);
      }}
      className={clsx(
        'flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed bg-surface px-6 py-14 text-center',
        dragging ? 'border-brand bg-brand/5' : 'border-line-strong',
      )}
    >
      <FileSpreadsheet className="size-8 text-muted" aria-hidden />
      <p className="font-bold">Arrastra aquí la hoja de tareas</p>
      <p className="max-w-md text-sm text-muted">
        Detectamos título, departamento, responsable, prioridad, estado y KPI. Si la primera fila tiene encabezados (Tarea, Área, Responsable…) los usamos; si no, la primera celda de cada fila es el título.
      </p>
      <Button className="mt-3" loading={upload.isPending} icon={<Upload className="size-4" />} onClick={() => input.current?.click()}>
        Elegir archivo .xlsx
      </Button>
      <p className="text-xs text-muted">Máx. 10 MB · 1000 filas</p>
      <input
        ref={input}
        type="file"
        hidden
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) send(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

// ─── Step 2: review ─────────────────────────────────────────────────────────

const cell = 'h-8 w-full rounded-md border border-line-strong bg-surface px-2 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';

function ReviewStep({
  importId,
  initial,
  unmapped,
  total,
  onDone,
  onCancel,
}: {
  importId: string;
  initial: DetectedTask[];
  unmapped: number;
  total: number;
  onDone: (r: ImportConfirmResult) => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState(() => initial.map(toRow));
  const departments = useDepartments();
  const users = useUsers();
  const confirm = useConfirmImport();
  const discard = useDiscardImport();

  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const selected = rows.filter((r) => r.include);
  const missingDept = selected.filter((r) => !r.departmentId || !r.title.trim()).length;
  const peopleByDept = useMemo(() => {
    const map = new Map<string, { id: string; displayName: string }[]>();
    for (const u of users.data ?? []) {
      if (u.role === 'VIEWER') continue;
      // ADMINs can take tasks in any department.
      const depts = u.role === 'ADMIN' ? (departments.data ?? []).map((d) => d.id) : u.departmentId ? [u.departmentId] : [];
      for (const d of depts) map.set(d, [...(map.get(d) ?? []), u]);
    }
    return map;
  }, [users.data, departments.data]);

  const submit = () => {
    const taskMappings: ImportMapping[] = selected.map((r) => ({
      rowIndex: r.rowIndex,
      title: r.title.trim(),
      departmentId: r.departmentId,
      ...(r.assignee === DEFAULT_ASSIGNEE ? {} : { assignedToId: r.assignee || null }),
      priority: r.priority,
      status: r.status,
      kpiTarget: r.kpiTarget.trim() || null,
      description: r.description ?? null,
      dueDate: r.dueDate ? new Date(`${r.dueDate}T12:00:00`).toISOString() : null,
    }));
    confirm.mutate(
      { importId, taskMappings },
      { onSuccess: onDone, onError: (e) => toast.error(e instanceof ApiError ? e.message : 'No se pudo importar') },
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-line bg-surface px-4 py-3 text-sm shadow-card">
        <span>
          <strong>{initial.length}</strong> tareas detectadas de <strong>{total}</strong> filas
        </span>
        {unmapped > 0 && <span className="text-sem-yellow">{unmapped} filas sin título se omitieron</span>}
        <span className="text-muted">Revisa y corrige antes de confirmar. Las filas sin departamento quedan desmarcadas.</span>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-card">
        <table className="w-full min-w-[56rem] text-sm">
          <thead className="border-b border-line bg-paper/70 text-left text-xs font-semibold uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="w-10 py-2.5 pl-4">
                <input
                  type="checkbox"
                  aria-label="Seleccionar todas"
                  className="size-4 accent-[var(--cp-primary)]"
                  checked={selected.length === rows.length && rows.length > 0}
                  onChange={(e) => setRows((rs) => rs.map((r) => ({ ...r, include: e.target.checked })))}
                />
              </th>
              <th scope="col" className="py-2.5 pr-2">Fila</th>
              <th scope="col" className="py-2.5 pr-2">Título</th>
              <th scope="col" className="py-2.5 pr-2">Departamento</th>
              <th scope="col" className="py-2.5 pr-2">Responsable</th>
              <th scope="col" className="py-2.5 pr-2">Prioridad</th>
              <th scope="col" className="py-2.5 pr-2">Estado</th>
              <th scope="col" className="py-2.5 pr-4">Confianza</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r, i) => (
              <tr key={r.rowIndex} className={clsx(!r.include && 'opacity-55')}>
                <td className="py-2 pl-4">
                  <input type="checkbox" aria-label={`Importar fila ${r.rowIndex + 1}`} className="size-4 accent-[var(--cp-primary)]" checked={r.include} onChange={(e) => set(i, { include: e.target.checked })} />
                </td>
                <td className="py-2 pr-2 font-mono text-xs text-muted tabular">{r.rowIndex + 1}</td>
                <td className="min-w-64 py-2 pr-2">
                  <input aria-label="Título" className={cell} value={r.title} maxLength={255} onChange={(e) => set(i, { title: e.target.value })} />
                </td>
                <td className="py-2 pr-2">
                  <select
                    aria-label="Departamento"
                    className={clsx(cell, r.include && !r.departmentId && 'border-sem-red')}
                    value={r.departmentId}
                    onChange={(e) => set(i, { departmentId: e.target.value, include: r.include || !!e.target.value, assignee: DEFAULT_ASSIGNEE })}
                  >
                    <option value="">— Elegir —</option>
                    {departments.data?.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-2 pr-2">
                  <select aria-label="Responsable" className={cell} value={r.assignee} disabled={!r.departmentId} onChange={(e) => set(i, { assignee: e.target.value })}>
                    <option value={DEFAULT_ASSIGNEE}>Jefe del área (por defecto)</option>
                    <option value="">Sin asignar</option>
                    {(peopleByDept.get(r.departmentId) ?? []).map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.displayName}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-2 pr-2">
                  <select aria-label="Prioridad" className={cell} value={r.priority} onChange={(e) => set(i, { priority: e.target.value as Priority })}>
                    {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => (
                      <option key={p} value={p}>
                        {PRIORITY_LABEL[p]}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-2 pr-2">
                  <select aria-label="Estado" className={cell} value={r.status} onChange={(e) => set(i, { status: e.target.value as ImportTaskStatus })}>
                    {(Object.keys(IMPORT_STATUS_LABEL) as ImportTaskStatus[]).map((s) => (
                      <option key={s} value={s}>
                        {IMPORT_STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-2 pr-4">
                  <Confidence value={r.confidence} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3">
        {missingDept > 0 && (
          <span className="mr-auto flex items-center gap-1.5 text-sm text-sem-red">
            <TriangleAlert className="size-4" aria-hidden /> {missingDept} filas seleccionadas sin título o departamento
          </span>
        )}
        <Button
          variant="ghost"
          loading={discard.isPending}
          onClick={() => discard.mutate(importId, { onSuccess: () => (toast.info('Importación descartada'), onCancel()) })}
        >
          Descartar
        </Button>
        <Button onClick={submit} loading={confirm.isPending} disabled={selected.length === 0 || missingDept > 0}>
          Importar {selected.length} {selected.length === 1 ? 'tarea' : 'tareas'}
        </Button>
      </div>
    </div>
  );
}

// ─── Step 3: done ───────────────────────────────────────────────────────────

function CompleteStep({ result, onAgain }: { result: ImportConfirmResult; onAgain: () => void }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-6 text-center shadow-card">
      <CircleCheck className="mx-auto size-10 text-sem-green" aria-hidden />
      <h2 className="mt-3 text-lg font-bold">
        {result.createdCount} {result.createdCount === 1 ? 'tarea creada' : 'tareas creadas'}
      </h2>
      {result.skippedCount > 0 && (
        <div className="mx-auto mt-4 max-w-lg text-left">
          <p className="text-sm font-semibold text-sem-yellow">{result.skippedCount} omitidas:</p>
          <ul className="mt-1 space-y-0.5 text-sm text-ink-soft">
            {result.skippedDetails.map((s) => (
              <li key={s.rowIndex}>
                Fila {s.rowIndex + 1}: {s.reason === 'Duplicate task in department' ? 'ya existe una tarea con ese título en el departamento' : s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-6 flex justify-center gap-2">
        <Button variant="secondary" onClick={onAgain}>
          Importar otro archivo
        </Button>
        <Link to="/tasks?week=all" className="inline-flex h-10 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white shadow-card hover:brightness-110">
          Ver tareas
        </Link>
      </div>
    </div>
  );
}

function History({ onResume }: { onResume: (s: ImportSummary) => void }) {
  const user = useAuth((s) => s.user)!;
  const imports = useImports();
  if (imports.isLoading) return <Skeleton className="h-24 w-full" />;
  if (!imports.data?.data.length) return null;
  return (
    <section aria-labelledby="history-heading" className="space-y-2">
      <h2 id="history-heading" className="text-sm font-bold">
        Importaciones recientes
      </h2>
      <ul className="divide-y divide-line rounded-2xl border border-line bg-surface shadow-card">
        {imports.data.data.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
            <span className="min-w-0 flex-1 truncate font-semibold">{i.filename}</span>
            <span className="text-muted">{formatDateTime(i.uploadedAt, user.timezone)}</span>
            <span className="text-ink-soft" title={i.status === 'FAILED' && i.errorMessage !== 'Discarded' ? (i.errorMessage ?? undefined) : undefined}>
              {i.status === 'COMPLETED' ? `${i.createdCount} creadas · ${i.skippedCount} omitidas` : `${i.detectedCount} detectadas`}
            </span>
            <span className={clsx('rounded-full px-2 py-0.5 text-xs font-semibold', i.status === 'PENDING' ? 'bg-sem-yellow-soft text-sem-yellow' : i.status === 'COMPLETED' ? 'bg-sem-green-soft text-sem-green' : 'bg-sunken text-muted')}>
              {i.status === 'FAILED' && i.errorMessage === 'Discarded' ? 'Descartado' : SUMMARY_STATUS[i.status]}
            </span>
            {i.status === 'PENDING' && (
              <Button size="sm" variant="secondary" onClick={() => onResume(i)}>
                Revisar
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

type Step =
  | { kind: 'upload' }
  | { kind: 'review'; importId: string; tasks: DetectedTask[]; unmapped: number; total: number }
  | { kind: 'complete'; result: ImportConfirmResult };

export default function DataImportPage() {
  const [step, setStep] = useState<Step>({ kind: 'upload' });

  const resume = async (s: ImportSummary) => {
    try {
      const r = await api<{ detectedTasks: DetectedTask[]; import: { failureCount: number; totalRows: number } }>(`/excel-imports/${s.id}`);
      setStep({ kind: 'review', importId: s.id, tasks: r.detectedTasks, unmapped: r.import.failureCount, total: r.import.totalRows });
    } catch {
      toast.error('No se pudo abrir la importación');
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Importar desde Excel</h1>
        <p className="mt-1 text-sm text-muted">Pasa tu hoja semanal a tareas en tres pasos: subir, revisar, confirmar.</p>
      </div>
      <ol className="flex gap-2 text-xs font-semibold" aria-label="Pasos">
        {(['upload', 'review', 'complete'] as const).map((k, i) => (
          <li key={k} aria-current={step.kind === k ? 'step' : undefined} className={clsx('rounded-full px-3 py-1', step.kind === k ? 'bg-navy text-white' : 'bg-sunken text-muted')}>
            {i + 1}. {k === 'upload' ? 'Subir' : k === 'review' ? 'Revisar' : 'Listo'}
          </li>
        ))}
      </ol>

      {step.kind === 'upload' && (
        <>
          <UploadStep onDetected={(importId, tasks, unmapped, total) => setStep({ kind: 'review', importId, tasks, unmapped, total })} />
          <History onResume={(s) => void resume(s)} />
        </>
      )}
      {step.kind === 'review' && (
        <ReviewStep
          key={step.importId}
          importId={step.importId}
          initial={step.tasks}
          unmapped={step.unmapped}
          total={step.total}
          onDone={(result) => setStep({ kind: 'complete', result })}
          onCancel={() => setStep({ kind: 'upload' })}
        />
      )}
      {step.kind === 'complete' && <CompleteStep result={step.result} onAgain={() => setStep({ kind: 'upload' })} />}
    </div>
  );
}
