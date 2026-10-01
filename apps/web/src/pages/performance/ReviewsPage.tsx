import { ArrowLeft, Trophy } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { AdminTable, Pagination, td, th } from '../../components/admin/AdminKit';
import { periodLabel, RatingBadge, recentPeriods, Score } from '../../components/performance/PerfBits';
import { PerfNav } from '../../components/performance/PerfNav';
import { EmptyState, ErrorNotice, Skeleton } from '../../components/ui/Feedback';
import { Select } from '../../components/ui/Field';
import { SURVEYS_PAGE_SIZE, useReviews } from '../../lib/performance';
import { useAuth } from '../../stores/auth';

// Quarterly results. Managers see their people's (published or not); everyone
// sees their own once published.
export default function ReviewsPage() {
  const role = useAuth((s) => s.user?.role);
  const [period, setPeriod] = useState('');
  const [page, setPage] = useState(1);
  const q = useReviews({ period: period || undefined, page });
  const manager = role === 'ADMIN' || role === 'JEFE_AREA';

  return (
    <div className="space-y-6">
      <Link to="/performance" className="inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Desempeño
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Resultados de desempeño</h1>
          <p className="mt-1 text-sm text-muted">
            {manager ? 'Consolidado trimestral de cada persona: se recalcula al enviar cada evaluación.' : 'Tus resultados publicados por trimestre.'}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Periodo</span>
          <Select
            className="w-36"
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Todos</option>
            {recentPeriods(8).map((p) => (
              <option key={p} value={p}>
                {periodLabel(p)}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <PerfNav />

      {q.isPending ? (
        <Skeleton className="h-48" />
      ) : q.isError ? (
        <ErrorNotice message="No se pudieron cargar los resultados." onRetry={() => void q.refetch()} />
      ) : q.data.data.length === 0 ? (
        <EmptyState icon={<Trophy className="size-6" />} title="Aún no hay resultados">
          {manager ? 'Aparecen cuando se envía la primera evaluación de una persona.' : 'Tu jefe publicará tu resultado al cerrar el trimestre.'}
        </EmptyState>
      ) : (
        <>
          <AdminTable
            caption="Resultados de desempeño"
            head={
              <tr>
                <th className={th}>Persona</th>
                <th className={th}>Periodo</th>
                <th className={th}>Autoevaluación</th>
                <th className={th}>Jefe</th>
                <th className={th}>Productividad</th>
                <th className={th}>Combinado</th>
                <th className={th}>Calificación</th>
                <th className={th}>Estado</th>
              </tr>
            }
          >
            {q.data.data.map((r) => (
              <tr key={r.id}>
                <td className={td}>
                  <Link to={`/performance/reviews/${r.id}`} className="font-semibold hover:underline">
                    {r.user.displayName}
                  </Link>
                  <p className="text-xs text-muted">{r.department?.name ?? '—'}</p>
                </td>
                <td className={`${td} whitespace-nowrap`}>{periodLabel(r.reviewPeriod)}</td>
                <td className={td}>
                  <Score value={r.selfAssessmentScore} />
                </td>
                <td className={td}>
                  <Score value={r.managerReviewScore} />
                </td>
                <td className={td}>
                  <Score value={r.overallProductivityIndex} />
                </td>
                <td className={td}>
                  <Score value={r.overallDualScore} />
                </td>
                <td className={td}>
                  <RatingBadge rating={r.performanceRating} />
                </td>
                <td className={`${td} text-xs`}>{r.publishedAt ? 'Publicado' : 'Borrador'}</td>
              </tr>
            ))}
          </AdminTable>
          <Pagination page={page} total={q.data.pagination.total} pageSize={SURVEYS_PAGE_SIZE} onPage={setPage} label="resultados" />
        </>
      )}
    </div>
  );
}
