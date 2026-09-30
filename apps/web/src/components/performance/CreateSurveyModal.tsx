import { useState } from 'react';
import { ApiError } from '../../lib/api';
import { dateInputToIso } from '../../lib/format';
import { currentPeriod, useCreateSurvey, useTemplates, type SurveyType } from '../../lib/performance';
import { useUsers } from '../../lib/queries';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/toast';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input, Select } from '../ui/Field';
import { periodLabel, recentPeriods } from './PerfBits';

type Kind = SurveyType | 'BOTH';

const today = () => new Intl.DateTimeFormat('en-CA').format(new Date());
const plusDays = (n: number) => new Intl.DateTimeFormat('en-CA').format(new Date(Date.now() + n * 86_400_000));

// Creates the evaluations of one person: their self-assessment, the manager
// review (filled by whoever creates it), or both at once.
export function CreateSurveyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const me = useAuth((s) => s.user);
  const templates = useTemplates('ACTIVE');
  // An area head evaluates their own department; the director anyone.
  const people = useUsers(me?.role === 'JEFE_AREA' ? (me.departmentId ?? undefined) : undefined, open);
  const create = useCreateSurvey();

  const [templateId, setTemplateId] = useState('');
  const [personId, setPersonId] = useState('');
  const [kind, setKind] = useState<Kind>('BOTH');
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState(plusDays(14));
  const [period, setPeriod] = useState(currentPeriod());
  const [errors, setErrors] = useState<Record<string, string>>({});

  // A head evaluates their team, not a peer head of the area (the API enforces it too).
  const candidates = (people.data ?? []).filter(
    (u) => u.id !== me?.id && u.role !== 'ADMIN' && u.departmentId && (me?.role === 'ADMIN' || u.role !== 'JEFE_AREA'),
  );

  function close() {
    setErrors({});
    onClose();
  }

  async function submit() {
    const e: Record<string, string> = {};
    if (!templateId) e.templateId = 'Elige una plantilla';
    if (!personId) e.evaluatedUserId = 'Elige a la persona';
    if (!start || !end || end <= start) e.endDate = 'La fecha de fin debe ser posterior al inicio';
    setErrors(e);
    if (Object.keys(e).length) return;

    const types: SurveyType[] = kind === 'BOTH' ? ['SELF_ASSESSMENT', 'MANAGER_REVIEW'] : [kind];
    // Start today = open now; end at the end of the chosen day.
    const startDate = start === today() ? new Date().toISOString() : dateInputToIso(start)!;
    const endDate = new Date(`${end}T23:59:00`).toISOString();
    try {
      for (const type of types) await create.mutateAsync({ templateId, type, evaluatedUserId: personId, startDate, endDate, reviewPeriod: period });
      toast.success(types.length > 1 ? 'Evaluaciones creadas' : 'Evaluación creada');
      close();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors({ ...err.fieldErrors, ...(Object.keys(err.fieldErrors).length ? {} : { form: err.message }) });
      } else setErrors({ form: 'No se pudo crear la evaluación' });
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Nueva evaluación"
      description="La persona recibe una notificación para completar su autoevaluación."
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} loading={create.isPending}>
            Crear
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Plantilla" error={errors.templateId} hint={templates.data?.length === 0 ? 'No hay plantillas activas; el director debe activar una.' : undefined}>
          {(id, d) => (
            <Select id={id} aria-describedby={d} invalid={!!errors.templateId} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Elegir</option>
              {templates.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.questions.length} preguntas)
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Persona evaluada" error={errors.evaluatedUserId}>
          {(id, d) => (
            <Select id={id} aria-describedby={d} invalid={!!errors.evaluatedUserId} value={personId} onChange={(e) => setPersonId(e.target.value)}>
              <option value="">Elegir</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Tipo" error={errors.evaluatorId}>
          {(id, d) => (
            <Select id={id} aria-describedby={d} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              <option value="BOTH">Autoevaluación + evaluación del jefe</option>
              <option value="SELF_ASSESSMENT">Solo autoevaluación</option>
              <option value="MANAGER_REVIEW">Solo evaluación del jefe (la llenas tú)</option>
            </Select>
          )}
        </Field>
        <Field label="Periodo evaluado" error={errors.reviewPeriod} hint="El trimestre al que suma el resultado.">
          {(id, d) => (
            <Select id={id} aria-describedby={d} value={period} onChange={(e) => setPeriod(e.target.value)}>
              {recentPeriods(4).map((p) => (
                <option key={p} value={p}>
                  {periodLabel(p)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Inicio" error={errors.startDate}>
            {(id, d) => <Input id={id} aria-describedby={d} type="date" value={start} min={today()} onChange={(e) => setStart(e.target.value)} />}
          </Field>
          <Field label="Fecha límite" error={errors.endDate}>
            {(id, d) => <Input id={id} aria-describedby={d} type="date" invalid={!!errors.endDate} value={end} min={start} onChange={(e) => setEnd(e.target.value)} />}
          </Field>
        </div>
        {errors.form && (
          <p role="alert" className="rounded-lg bg-sem-red-soft px-3 py-2 text-sm font-medium text-sem-red">
            {errors.form}
          </p>
        )}
      </div>
    </Dialog>
  );
}
