import clsx from 'clsx';
import { ArrowDown, ArrowUp, ClipboardList, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { AdminPageHeader, ConfirmDialog, StatusBadge } from '../../components/admin/AdminKit';
import { QUESTION_TYPE_LABEL } from '../../components/performance/PerfBits';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { EmptyState, ErrorNotice, Skeleton } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { ApiError } from '../../lib/api';
import {
  useDeleteTemplate,
  useSaveTemplate,
  useTemplateStatus,
  useTemplates,
  type QuestionDraft,
  type QuestionType,
  type SurveyTemplate,
} from '../../lib/performance';
import { toast } from '../../stores/toast';

const SCORED: QuestionType[] = ['LIKERT_5', 'LIKERT_7', 'NUMERIC'];
const MIN_QUESTIONS = 3;

const blank = (questionType: QuestionType = 'LIKERT_5'): QuestionDraft => ({ text: '', questionType, weight: 1, required: true, options: [] });

// Same rules as the API (Risk 3), checked before sending so the form can point at them.
export function templateProblems(name: string, questions: QuestionDraft[]): string[] {
  const out: string[] = [];
  if (!name.trim()) out.push('Ponle un nombre a la plantilla.');
  if (questions.length < MIN_QUESTIONS) out.push(`Necesita al menos ${MIN_QUESTIONS} preguntas.`);
  if (!questions.some((q) => SCORED.includes(q.questionType))) out.push('Incluye al menos una pregunta con escala (1–5, 1–7) o número (0–100) para calcular el puntaje.');
  questions.forEach((q, i) => {
    if (!q.text.trim()) out.push(`La pregunta ${i + 1} no tiene texto.`);
    if (q.questionType === 'RANKING' && q.options.filter((o) => o.trim()).length < 2) out.push(`La pregunta ${i + 1} (ranking) necesita al menos 2 opciones.`);
  });
  return out;
}

function TemplateEditor({ template, open, onClose }: { template: SurveyTemplate | null; open: boolean; onClose: () => void }) {
  const save = useSaveTemplate();
  const [name, setName] = useState(template?.name ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [questions, setQuestions] = useState<QuestionDraft[]>(
    template?.questions.map(({ text, questionType, weight, required, options }) => ({ text, questionType, weight, required, options })) ?? [
      blank('LIKERT_5'),
      blank('LIKERT_5'),
      blank('TEXT'),
    ],
  );
  const [problems, setProblems] = useState<string[]>([]);

  const patch = (i: number, p: Partial<QuestionDraft>) => setQuestions((qs) => qs.map((q, j) => (j === i ? { ...q, ...p } : q)));
  const move = (i: number, dir: -1 | 1) =>
    setQuestions((qs) => {
      const next = [...qs];
      [next[i], next[i + dir]] = [next[i + dir]!, next[i]!];
      return next;
    });

  async function submit() {
    const found = templateProblems(name, questions);
    setProblems(found);
    if (found.length) return;
    const input = {
      name: name.trim(),
      description: description.trim() || null,
      questions: questions.map((q) => ({
        ...q,
        text: q.text.trim(),
        options: q.questionType === 'RANKING' ? q.options.map((o) => o.trim()).filter(Boolean) : [],
      })),
    };
    try {
      await save.mutateAsync({ id: template?.id, input });
      toast.success(template ? 'Plantilla actualizada' : 'Plantilla creada como borrador');
      onClose();
    } catch (e) {
      setProblems([e instanceof ApiError ? [e.message, ...Object.values(e.fieldErrors)].join(' ') : 'No se pudo guardar la plantilla']);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={template ? 'Editar plantilla' : 'Nueva plantilla'}
      description="Mínimo 3 preguntas y al menos una con escala o número. Al activarla, sus preguntas quedan fijas."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={save.isPending} onClick={() => void submit()}>
            Guardar borrador
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Nombre">{(id) => <Input id={id} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Descripción (opcional)">{(id) => <Input id={id} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        </div>

        <ol className="space-y-3">
          {questions.map((q, i) => (
            <li key={i} className="rounded-xl border border-line bg-paper/60 p-3">
              <div className="flex flex-wrap items-start gap-2">
                <span className="tabular mt-2.5 w-6 text-sm font-bold text-muted">{i + 1}.</span>
                <div className="min-w-0 flex-1 space-y-2">
                  <Input aria-label={`Texto de la pregunta ${i + 1}`} placeholder="¿Qué quieres preguntar?" maxLength={500} value={q.text} onChange={(e) => patch(i, { text: e.target.value })} />
                  <div className="flex flex-wrap items-center gap-2">
                    <Select
                      aria-label={`Tipo de la pregunta ${i + 1}`}
                      className="w-48"
                      value={q.questionType}
                      onChange={(e) => {
                        const questionType = e.target.value as QuestionType;
                        patch(i, { questionType, options: questionType === 'RANKING' ? (q.options.length ? q.options : ['', '']) : [] });
                      }}
                    >
                      {(Object.keys(QUESTION_TYPE_LABEL) as QuestionType[]).map((t) => (
                        <option key={t} value={t}>
                          {QUESTION_TYPE_LABEL[t]}
                        </option>
                      ))}
                    </Select>
                    {SCORED.includes(q.questionType) && (
                      <label className="flex items-center gap-1.5 text-sm">
                        <span className="text-muted">Peso</span>
                        <Input
                          type="number"
                          min={0.1}
                          max={10}
                          step={0.5}
                          className="w-20"
                          aria-label={`Peso de la pregunta ${i + 1}`}
                          value={q.weight}
                          onChange={(e) => patch(i, { weight: Number(e.target.value) || 1 })}
                        />
                      </label>
                    )}
                    <label className="flex items-center gap-1.5 text-sm">
                      <input type="checkbox" checked={q.required} onChange={(e) => patch(i, { required: e.target.checked })} />
                      Obligatoria
                    </label>
                  </div>
                  {q.questionType === 'RANKING' && (
                    <div className="space-y-1.5">
                      {q.options.map((opt, j) => (
                        <div key={j} className="flex gap-2">
                          <Input
                            aria-label={`Opción ${j + 1} de la pregunta ${i + 1}`}
                            value={opt}
                            maxLength={120}
                            onChange={(e) => patch(i, { options: q.options.map((o, k) => (k === j ? e.target.value : o)) })}
                          />
                          <Button variant="ghost" size="sm" aria-label={`Quitar opción ${j + 1}`} onClick={() => patch(i, { options: q.options.filter((_, k) => k !== j) })}>
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      ))}
                      {q.options.length < 10 && (
                        <Button variant="ghost" size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={() => patch(i, { options: [...q.options, ''] })}>
                          Opción
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex items-center">
                  <Button variant="ghost" size="sm" disabled={i === 0} aria-label={`Subir pregunta ${i + 1}`} onClick={() => move(i, -1)}>
                    <ArrowUp className="size-4" />
                  </Button>
                  <Button variant="ghost" size="sm" disabled={i === questions.length - 1} aria-label={`Bajar pregunta ${i + 1}`} onClick={() => move(i, 1)}>
                    <ArrowDown className="size-4" />
                  </Button>
                  <Button variant="ghost" size="sm" aria-label={`Eliminar pregunta ${i + 1}`} onClick={() => setQuestions((qs) => qs.filter((_, j) => j !== i))}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ol>
        {questions.length < 50 && (
          <Button variant="secondary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setQuestions((qs) => [...qs, blank()])}>
            Agregar pregunta
          </Button>
        )}

        {problems.length > 0 && (
          <ul role="alert" className="space-y-1 rounded-lg bg-sem-red-soft px-3 py-2 text-sm font-medium text-sem-red">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

const STATUS_TEXT = { DRAFT: 'Borrador', ACTIVE: 'Activa', ARCHIVED: 'Archivada' } as const;

export default function SurveyTemplatesPage() {
  const templates = useTemplates();
  const setStatus = useTemplateStatus();
  const remove = useDeleteTemplate();
  const [editing, setEditing] = useState<SurveyTemplate | null | 'new'>(null);
  const [deleting, setDeleting] = useState<SurveyTemplate | null>(null);

  return (
    <div className="space-y-6">
      <AdminPageHeader
        section="Desempeño"
        title="Plantillas de encuesta"
        description="Las preguntas de las autoevaluaciones y evaluaciones del jefe. Solo las plantillas activas se pueden usar."
        actions={
          <Button icon={<Plus className="size-4" aria-hidden />} onClick={() => setEditing('new')}>
            Nueva plantilla
          </Button>
        }
      />

      {templates.isPending ? (
        <Skeleton className="h-40" />
      ) : templates.isError ? (
        <ErrorNotice message="No se pudieron cargar las plantillas." onRetry={() => void templates.refetch()} />
      ) : templates.data.length === 0 ? (
        <EmptyState icon={<ClipboardList className="size-6" />} title="Aún no hay plantillas" action={<Button onClick={() => setEditing('new')}>Crear la primera</Button>}>
          Crea una plantilla y actívala para empezar a evaluar.
        </EmptyState>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {templates.data.map((t) => (
            <li key={t.id} className={clsx('rounded-2xl border border-line bg-surface p-5 shadow-card', t.status === 'ARCHIVED' && 'opacity-70')}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-bold">{t.name}</h2>
                  {t.description && <p className="text-sm text-muted">{t.description}</p>}
                </div>
                <StatusBadge active={t.status === 'ACTIVE'}>{STATUS_TEXT[t.status]}</StatusBadge>
              </div>
              <ol className="mt-3 space-y-1 text-sm text-ink-soft">
                {t.questions.map((q) => (
                  <li key={q.id} className="flex gap-2">
                    <span className="tabular text-muted">{q.questionNumber}.</span>
                    <span className="flex-1">{q.text}</span>
                    <span className="whitespace-nowrap text-xs text-muted">{QUESTION_TYPE_LABEL[q.questionType]}</span>
                  </li>
                ))}
              </ol>
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                <span className="mr-auto text-xs text-muted">{t.surveysCount} evaluaciones</span>
                {t.status === 'DRAFT' && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(t)}>
                      Eliminar
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditing(t)}>
                      Editar
                    </Button>
                    <Button size="sm" onClick={() => setStatus.mutate({ id: t.id, status: 'ACTIVE' }, { onSuccess: () => toast.success('Plantilla activada') })}>
                      Activar
                    </Button>
                  </>
                )}
                {t.status === 'ACTIVE' && (
                  <Button size="sm" variant="secondary" onClick={() => setStatus.mutate({ id: t.id, status: 'ARCHIVED' })}>
                    Archivar
                  </Button>
                )}
                {t.status === 'ARCHIVED' && (
                  <Button size="sm" variant="secondary" onClick={() => setStatus.mutate({ id: t.id, status: 'ACTIVE' })}>
                    Reactivar
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && <TemplateEditor open template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!deleting}
        title="¿Eliminar este borrador?"
        description={deleting?.name}
        confirmLabel="Eliminar"
        loading={remove.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
      />
    </div>
  );
}
