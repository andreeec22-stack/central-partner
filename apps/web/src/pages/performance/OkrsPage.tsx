import clsx from 'clsx';
import { ChevronRight, Plus, Target } from 'lucide-react';
import { useState } from 'react';
import { OKR_LEVEL_LABEL, OKR_STATUS_LABEL, OkrProgressBar, OkrStatusBadge } from '../../components/okrs/OkrBits';
import { OkrDetailDialog } from '../../components/okrs/OkrDetailDialog';
import { OkrFormModal } from '../../components/okrs/OkrFormModal';
import { periodLabel, recentPeriods } from '../../components/performance/PerfBits';
import { PerfNav } from '../../components/performance/PerfNav';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorNotice, Skeleton } from '../../components/ui/Feedback';
import { Select } from '../../components/ui/Field';
import { useOkrTree, type Okr, type OkrNode, type OkrStatus } from '../../lib/okrs';
import { currentPeriod } from '../../lib/performance';
import { useAuth } from '../../stores/auth';

function OkrRow({ node, depth, onOpen }: { node: OkrNode; depth: number; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(depth < 1);
  const who = node.owner?.displayName ?? node.department?.name;
  return (
    <li>
      <div className="flex items-center gap-2 border-b border-line py-2.5" style={{ paddingLeft: `${depth * 1.5}rem` }}>
        {node.children.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={`${open ? 'Ocultar' : 'Mostrar'} objetivos de ${node.title}`}
            className="rounded p-0.5 text-muted hover:bg-sunken"
          >
            <ChevronRight className={clsx('size-4 transition', open && 'rotate-90')} />
          </button>
        ) : (
          <span className="w-5" aria-hidden />
        )}
        <button type="button" onClick={() => onOpen(node.id)} className="min-w-0 flex-1 text-left">
          <span className="block truncate text-sm font-semibold hover:underline">{node.title}</span>
          <span className="block truncate text-xs text-muted">
            {[OKR_LEVEL_LABEL[node.level], who, `${node.keyResults.length} resultados clave`].filter(Boolean).join(' · ')}
          </span>
        </button>
        <div className="hidden w-48 sm:block">
          <OkrProgressBar progress={node.progress} expected={node.expectedProgress} status={node.status} label={`Avance de ${node.title}`} />
        </div>
        <span className="tabular w-12 text-right text-xs font-bold sm:hidden">{Math.round(node.progress)}%</span>
        <OkrStatusBadge status={node.status} />
      </div>
      {open && node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <OkrRow key={c.id} node={c} depth={depth + 1} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function OkrsPage() {
  const role = useAuth((s) => s.user?.role);
  const manager = role === 'ADMIN' || role === 'JEFE_AREA';
  const [period, setPeriod] = useState(currentPeriod());
  const tree = useOkrTree(period);
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<{ okr: Okr | null } | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Objetivos (OKRs)</h1>
          <p className="mt-1 text-sm text-muted">De la empresa a cada área y persona. El estado compara el avance con lo esperado a la fecha.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Periodo</span>
            <Select className="w-36" value={period} onChange={(e) => setPeriod(e.target.value)}>
              {recentPeriods(6).map((p) => (
                <option key={p} value={p}>
                  {periodLabel(p)}
                </option>
              ))}
            </Select>
          </label>
          {manager && (
            <Button icon={<Plus className="size-4" aria-hidden />} onClick={() => setForm({ okr: null })}>
              Nuevo objetivo
            </Button>
          )}
        </div>
      </div>
      <PerfNav />

      {tree.isPending ? (
        <Skeleton className="h-60" />
      ) : tree.isError ? (
        <ErrorNotice message="No se pudieron cargar los objetivos." onRetry={() => void tree.refetch()} />
      ) : tree.data.summary.total === 0 ? (
        <EmptyState
          icon={<Target className="size-6" />}
          title="Sin objetivos en este trimestre"
          action={manager ? <Button onClick={() => setForm({ okr: null })}>Crear el primero</Button> : undefined}
        >
          {manager ? 'Empieza por un objetivo de empresa y baja a las áreas.' : 'Tu jefe publicará los objetivos del trimestre.'}
        </EmptyState>
      ) : (
        <>
          <ul aria-label="Resumen" className="flex flex-wrap gap-2 text-sm">
            {(['ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'COMPLETED'] as OkrStatus[]).map((st) => (
              <li key={st} className="rounded-full border border-line bg-surface px-3 py-1">
                <span className="tabular font-bold">{tree.data.summary[st]}</span> {OKR_STATUS_LABEL[st].toLowerCase()}
              </li>
            ))}
          </ul>
          <section aria-label="Árbol de objetivos" className="rounded-2xl border border-line bg-surface px-4 shadow-card">
            <ul>
              {tree.data.roots.map((n) => (
                <OkrRow key={n.id} node={n} depth={0} onOpen={setOpenId} />
              ))}
            </ul>
          </section>
        </>
      )}

      {openId && (
        <OkrDetailDialog
          id={openId}
          onClose={() => setOpenId(null)}
          onEdit={(okr) => {
            setOpenId(null);
            setForm({ okr });
          }}
        />
      )}
      {form && <OkrFormModal period={period} okr={form.okr} tree={tree.data?.roots ?? []} onClose={() => setForm(null)} />}
    </div>
  );
}
