import { CircleCheck, CircleX, Download, Eye, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError } from '../../lib/api';
import { type CloseResult, downloadReport, downloadWeek, useCloseWeek, useClosureCheck, type WeekRow } from '../../lib/admin';
import { formatPercent, toPercent } from '../../lib/format';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Spinner } from '../ui/Feedback';

function missing(d: { tasksWithoutProgress: number; kpisMissing: number; functionsUnmarked: number; noKpis: boolean; noFunctions: boolean }) {
  const out: string[] = [];
  if (d.noKpis) out.push('sin KPIs definidos');
  else if (d.kpisMissing) out.push(`${d.kpisMissing} KPI${d.kpisMissing > 1 ? 's' : ''} sin real`);
  if (d.noFunctions) out.push('sin funciones definidas');
  else if (d.functionsUnmarked) out.push(`${d.functionsUnmarked} función${d.functionsUnmarked > 1 ? 'es' : ''} sin marcar`);
  if (d.tasksWithoutProgress) out.push(`${d.tasksWithoutProgress} tarea${d.tasksWithoutProgress > 1 ? 's' : ''} vencida${d.tasksWithoutProgress > 1 ? 's' : ''} en 0%`);
  return out.join(' · ');
}

// Step 1: completeness check per area → Step 2: archived, with the file.
export function CloseWeekModal({ week, onClose, onViewHistory }: { week: WeekRow | null; onClose: () => void; onViewHistory: () => void }) {
  const check = useClosureCheck(week?.id ?? null);
  const close = useCloseWeek();
  const [result, setResult] = useState<CloseResult | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (week) setResult(null);
  }, [week]);

  const report = check.data;
  const incomplete = report?.incompleteCount ?? 0;

  const confirm = () =>
    close.mutate(
      { weekId: week!.id, force: incomplete > 0 },
      {
        onSuccess: setResult,
        onError: () => undefined, // shown inline below
      },
    );

  const title = result ? `✅ Semana ${result.week.weekNumber} archivada` : `Cierre de la semana ${week?.weekNumber ?? ''}`;

  return (
    <Dialog
      open={!!week}
      onClose={onClose}
      title={title}
      description={result ? undefined : 'Paso 1 de 2 · Validación de completitud'}
      footer={
        result ? (
          <>
            <Button
              variant="secondary"
              icon={<Eye className="size-4" />}
              onClick={() => {
                onClose();
                onViewHistory();
              }}
            >
              Ver histórico
            </Button>
            <Button
              icon={<Download className="size-4" />}
              loading={downloading}
              onClick={async () => {
                setDownloading(true);
                // The stored report generated on close; on-demand if that failed.
                if (result.report) await downloadReport(result.report);
                else await downloadWeek(result.week.id, result.week.weekNumber);
                setDownloading(false);
              }}
            >
              Descargar Excel
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              No, volver
            </Button>
            <Button variant={incomplete ? 'danger' : 'primary'} loading={close.isPending} disabled={!report || !report.canClose} onClick={confirm}>
              {incomplete ? 'Sí, cerrar igual' : 'Cerrar semana'}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <ul className="space-y-2 text-sm">
          <li>• Datos guardados en el histórico (índice final {formatPercent(toPercent(result.overall.index))}).</li>
          <li>
            {result.report
              ? `• Reporte Excel generado (${result.report.sheetCount} hojas) y guardado 30 días en Reportes semanales.`
              : '• El reporte Excel automático no se pudo generar; descárgalo aquí o genéralo desde Reportes semanales.'}
          </li>
          <li>
            • Nueva semana {result.nextWeek.weekNumber} lista ({result.nextWeek.mondayDate} al {result.nextWeek.saturdayDate}), con los KPIs y funciones de esta.
          </li>
          <li>
            • {result.carriedTasks
              ? `${result.carriedTasks} tarea${result.carriedTasks > 1 ? 's' : ''} sin terminar pasa${result.carriedTasks > 1 ? 'n' : ''} a la nueva semana con su avance (“Viene de Sem. ${result.week.weekNumber}”).`
              : 'No quedaron tareas pendientes.'}
          </li>
          <li>• Las observaciones y los resultados de KPIs y funciones empiezan en blanco.</li>
        </ul>
      ) : check.isLoading ? (
        <Spinner label="Revisando cada área…" />
      ) : check.isError ? (
        <p role="alert" className="text-sm text-sem-red">
          No pudimos validar la semana. Intenta de nuevo.
        </p>
      ) : report ? (
        <div className="space-y-3">
          <p className="text-sm text-ink-soft">Al cerrar, el reporte Excel de la semana se generará automáticamente y quedará guardado 30 días en Reportes semanales.</p>
          {!report.canClose && (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-sem-yellow-soft px-3 py-2 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-sem-yellow" aria-hidden />
              Aún no se puede cerrar: el cierre se habilita el sábado desde las 10:00.
            </p>
          )}
          <ul aria-label="Validación por área" className="max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {report.departments.map((d) => (
              <li key={d.departmentId} className="flex items-start gap-2 px-3 py-2 text-sm">
                {d.complete ? (
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-sem-green" aria-label="Completo" />
                ) : (
                  <CircleX className="mt-0.5 size-4 shrink-0 text-sem-red" aria-label="Incompleto" />
                )}
                <span>
                  <span className="font-semibold">{d.departmentName}</span> — {d.complete ? 'OK' : missing(d)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-sm font-semibold">
            {incomplete ? `${incomplete} área${incomplete > 1 ? 's' : ''} con datos sin llenar. ¿Continuar igual?` : 'Todas las áreas completas. ¿Cerrar la semana?'}
          </p>
          {close.isError && (
            <p role="alert" className="text-sm text-sem-red">
              {close.error instanceof ApiError ? close.error.message : 'No se pudo cerrar la semana.'}
            </p>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
