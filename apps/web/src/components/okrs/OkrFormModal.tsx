import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ApiError } from '../../lib/api';
import { useSaveOkr, type KeyResultDraft, type Okr, type OkrLevel, type OkrNode } from '../../lib/okrs';
import { useDepartments, useUsers } from '../../lib/queries';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/toast';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input, Select, Textarea } from '../ui/Field';
import { OKR_LEVEL_LABEL } from './OkrBits';

const MAX_KRS = 5;
const PARENT_LEVEL: Record<OkrLevel, OkrLevel | null> = { COMPANY: null, AREA: 'COMPANY', PERSON: 'AREA' };
const blankKr = (): KeyResultDraft => ({ title: '', unit: null, startValue: 0, target: 100 });

function flatten(nodes: OkrNode[]): Okr[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

// Create or edit an OKR. Level, area and owner are chosen on creation only.
export function OkrFormModal({ period, okr, tree, onClose }: { period: string; okr: Okr | null; tree: OkrNode[]; onClose: () => void }) {
  const me = useAuth((s) => s.user);
  const isAdmin = me?.role === 'ADMIN';
  const save = useSaveOkr();
  const departments = useDepartments();

  const [level, setLevel] = useState<OkrLevel>(okr?.level ?? (isAdmin ? 'COMPANY' : 'AREA'));
  const [departmentId, setDepartmentId] = useState(okr?.department?.id ?? (isAdmin ? '' : (me?.departmentId ?? '')));
  const [ownerUserId, setOwnerUserId] = useState(okr?.owner?.id ?? '');
  const [parentId, setParentId] = useState(okr?.parentId ?? '');
  const [title, setTitle] = useState(okr?.title ?? '');
  const [description, setDescription] = useState(okr?.description ?? '');
  const [deadline, setDeadline] = useState(okr?.deadline ?? '');
  const [krs, setKrs] = useState<KeyResultDraft[]>(
    okr?.keyResults.map(({ id, title, unit, startValue, target }) => ({ id, title, unit, startValue, target })) ?? [blankKr()],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  // People: the director picks anyone with an area; a head, their team.
  const people = useUsers(isAdmin ? undefined : (me?.departmentId ?? undefined), level === 'PERSON' && !okr);
  const candidates = (people.data ?? []).filter((u) => u.departmentId && u.role !== 'ADMIN' && (isAdmin || (u.role !== 'JEFE_AREA' && u.id !== me?.id)));
  const ownerDept = level === 'PERSON' ? candidates.find((u) => u.id === ownerUserId)?.departmentId : departmentId;

  const parents = useMemo(() => {
    const want = PARENT_LEVEL[level];
    if (!want) return [];
    return flatten(tree).filter((o) => o.level === want && o.id !== okr?.id && (want !== 'AREA' || o.department?.id === (okr?.department?.id ?? ownerDept)));
  }, [tree, level, okr, ownerDept]);

  const patchKr = (i: number, p: Partial<KeyResultDraft>) => setKrs((list) => list.map((k, j) => (j === i ? { ...k, ...p } : k)));

  async function submit() {
    const e: Record<string, string> = {};
    if (!title.trim()) e.title = 'Escribe el objetivo';
    if (!okr && level === 'AREA' && !departmentId) e.departmentId = 'Elige el área';
    if (!okr && level === 'PERSON' && !ownerUserId) e.ownerUserId = 'Elige a la persona';
    krs.forEach((k, i) => {
      if (!k.title.trim()) e[`kr${i}`] = 'Describe el resultado clave';
      else if (!Number.isFinite(k.target) || !Number.isFinite(k.startValue)) e[`kr${i}`] = 'Inicio y meta deben ser números';
    });
    setErrors(e);
    if (Object.keys(e).length) return;

    try {
      await save.mutateAsync({
        id: okr?.id,
        input: {
          period,
          level,
          parentId: parentId || null,
          ...(level === 'AREA' ? { departmentId } : {}),
          ...(level === 'PERSON' ? { ownerUserId } : {}),
          title: title.trim(),
          description: description.trim() || null,
          deadline: deadline || null,
          keyResults: krs.map((k) => ({ ...k, title: k.title.trim(), unit: k.unit?.trim() || null })),
        },
      });
      toast.success(okr ? 'Objetivo actualizado' : 'Objetivo creado');
      onClose();
    } catch (err) {
      if (err instanceof ApiError) setErrors({ ...err.fieldErrors, form: err.message });
      else setErrors({ form: 'No se pudo guardar el objetivo' });
    }
  }

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={okr ? 'Editar objetivo' : 'Nuevo objetivo'}
      description={`Trimestre ${period.replace('-Q', ' · T')}. Hasta ${MAX_KRS} resultados clave; el avance es su promedio.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={save.isPending} onClick={() => void submit()}>
            {okr ? 'Guardar' : 'Crear objetivo'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!okr && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nivel">
              {(id) => (
                <Select
                  id={id}
                  value={level}
                  onChange={(e) => {
                    setLevel(e.target.value as OkrLevel);
                    setParentId('');
                  }}
                >
                  {(isAdmin ? (['COMPANY', 'AREA', 'PERSON'] as const) : (['AREA', 'PERSON'] as const)).map((l) => (
                    <option key={l} value={l}>
                      {OKR_LEVEL_LABEL[l]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {level === 'AREA' && (
              <Field label="Área" error={errors.departmentId}>
                {(id, d) => (
                  <Select id={id} aria-describedby={d} invalid={!!errors.departmentId} value={departmentId} disabled={!isAdmin} onChange={(e) => setDepartmentId(e.target.value)}>
                    <option value="">Elegir</option>
                    {departments.data?.map((dep) => (
                      <option key={dep.id} value={dep.id}>
                        {dep.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            {level === 'PERSON' && (
              <Field label="Persona" error={errors.ownerUserId}>
                {(id, d) => (
                  <Select id={id} aria-describedby={d} invalid={!!errors.ownerUserId} value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)}>
                    <option value="">Elegir</option>
                    {candidates.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.displayName}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
          </div>
        )}

        {PARENT_LEVEL[level] && (
          <Field label={`Contribuye a (objetivo ${PARENT_LEVEL[level] === 'COMPANY' ? 'de empresa' : 'del área'}, opcional)`} error={errors.parentId}>
            {(id, d) => (
              <Select id={id} aria-describedby={d} value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">Ninguno</option>
                {parents.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}

        <Field label="Objetivo" error={errors.title}>
          {(id, d) => <Input id={id} aria-describedby={d} invalid={!!errors.title} maxLength={200} placeholder="Ej.: Aumentar la retención de clientes" value={title} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
          <Field label="Descripción (opcional)">{(id) => <Textarea id={id} maxLength={2000} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
          <Field label="Fecha límite (opcional)" error={errors.deadline} hint="Por defecto, fin del trimestre">
            {(id, d) => <Input id={id} aria-describedby={d} type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />}
          </Field>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">Resultados clave</legend>
          <p className="text-xs text-muted">Si la meta es menor que el inicio, se entiende que menos es mejor (p. ej. churn 8 → 5).</p>
          {krs.map((k, i) => (
            <div key={i} className="rounded-xl border border-line bg-paper/60 p-3">
              <div className="flex gap-2">
                <Input aria-label={`Resultado clave ${i + 1}`} placeholder="Ej.: Clientes nuevos" maxLength={200} invalid={!!errors[`kr${i}`]} value={k.title} onChange={(e) => patchKr(i, { title: e.target.value })} />
                {krs.length > 1 && (
                  <Button variant="ghost" size="sm" aria-label={`Quitar resultado clave ${i + 1}`} onClick={() => setKrs((list) => list.filter((_, j) => j !== i))}>
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <label className="text-xs text-muted">
                  Inicio
                  <Input type="number" step="any" aria-label={`Inicio del resultado clave ${i + 1}`} value={k.startValue} onChange={(e) => patchKr(i, { startValue: Number(e.target.value) })} />
                </label>
                <label className="text-xs text-muted">
                  Meta
                  <Input type="number" step="any" aria-label={`Meta del resultado clave ${i + 1}`} value={k.target} onChange={(e) => patchKr(i, { target: Number(e.target.value) })} />
                </label>
                <label className="text-xs text-muted">
                  Unidad
                  <Input aria-label={`Unidad del resultado clave ${i + 1}`} placeholder="%, clientes…" maxLength={20} value={k.unit ?? ''} onChange={(e) => patchKr(i, { unit: e.target.value })} />
                </label>
              </div>
              {errors[`kr${i}`] && <p className="mt-1 text-xs font-medium text-sem-red">{errors[`kr${i}`]}</p>}
            </div>
          ))}
          {krs.length < MAX_KRS && (
            <Button variant="secondary" size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={() => setKrs((list) => [...list, blankKr()])}>
              Resultado clave
            </Button>
          )}
        </fieldset>

        {errors.form && (
          <p role="alert" className="rounded-lg bg-sem-red-soft px-3 py-2 text-sm font-medium text-sem-red">
            {errors.form}
          </p>
        )}
      </div>
    </Dialog>
  );
}
