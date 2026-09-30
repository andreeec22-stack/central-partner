import { Check, Copy } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import { useInviteUser, useUpdateUser, type AdminUser } from '../../lib/admin';
import { ROLE_LABEL } from '../../lib/labels';
import { useDepartments } from '../../lib/queries';
import type { Role } from '../../lib/types';
import { toast } from '../../stores/toast';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input, Select } from '../ui/Field';

const ROLES: Role[] = ['ADMIN', 'JEFE_AREA', 'USER', 'VIEWER'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+[1-9]\d{7,14}$/;

interface Form {
  email: string;
  displayName: string;
  role: Role;
  departmentId: string;
  canCreateTasks: boolean;
  phoneNumber: string;
}

// Real-time validation: the same rules the API applies.
function validate(f: Form, mode: 'create' | 'edit'): Partial<Record<keyof Form, string>> {
  const e: Partial<Record<keyof Form, string>> = {};
  if (mode === 'create' && !EMAIL.test(f.email.trim())) e.email = 'Escribe un correo válido';
  if (mode === 'edit' && !f.displayName.trim()) e.displayName = 'El nombre es obligatorio';
  if (f.role !== 'ADMIN' && !f.departmentId) e.departmentId = 'Elige el departamento';
  if (f.phoneNumber.trim() && !PHONE.test(f.phoneNumber.replace(/\s+/g, ''))) e.phoneNumber = 'Formato internacional, p. ej. +51999123456';
  return e;
}

function UserFields({ form, set, errors, touched, mode }: { form: Form; set: (p: Partial<Form>) => void; errors: Partial<Record<keyof Form, string>>; touched: boolean; mode: 'create' | 'edit' }) {
  const departments = useDepartments();
  const show = (k: keyof Form) => (touched ? errors[k] : undefined);
  return (
    <div className="space-y-4">
      {mode === 'create' ? (
        <Field label="Correo" error={show('email')} hint="Le llegará una invitación para crear su contraseña.">
          {(id, d) => <Input id={id} aria-describedby={d} type="email" autoComplete="off" value={form.email} invalid={!!show('email')} onChange={(e) => set({ email: e.target.value })} />}
        </Field>
      ) : (
        <Field label="Nombre" error={show('displayName')}>
          {(id, d) => <Input id={id} aria-describedby={d} maxLength={100} value={form.displayName} invalid={!!show('displayName')} onChange={(e) => set({ displayName: e.target.value })} />}
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Rol">
          {(id) => (
            <Select id={id} value={form.role} onChange={(e) => set({ role: e.target.value as Role })}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Departamento" error={show('departmentId')} hint={form.role === 'ADMIN' ? 'Opcional para el director' : undefined}>
          {(id, d) => (
            <Select id={id} aria-describedby={d} value={form.departmentId} invalid={!!show('departmentId')} onChange={(e) => set({ departmentId: e.target.value })}>
              <option value="">{form.role === 'ADMIN' ? 'Ninguno' : '— Elegir —'}</option>
              {departments.data?.map((dep) => (
                <option key={dep.id} value={dep.id}>
                  {dep.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {form.role === 'JEFE_AREA' && (
        <label className="flex items-start gap-2.5 rounded-lg bg-paper px-3 py-2.5 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--cp-primary)]" checked={form.canCreateTasks} onChange={(e) => set({ canCreateTasks: e.target.checked })} />
          <span>
            <span className="font-semibold">Puede crear tareas</span>
            <span className="block text-xs text-muted">En su propio departamento. Se puede cambiar luego en Permisos.</span>
          </span>
        </label>
      )}
      <Field label="WhatsApp (opcional)" error={show('phoneNumber')} hint="Con código de país, p. ej. +51 999 123 456">
        {(id, d) => (
          <Input id={id} aria-describedby={d} type="tel" value={form.phoneNumber} invalid={!!show('phoneNumber')} onChange={(e) => set({ phoneNumber: e.target.value })} placeholder="+51 999 123 456" />
        )}
      </Field>
    </div>
  );
}

const emptyForm: Form = { email: '', displayName: '', role: 'USER', departmentId: '', canCreateTasks: false, phoneNumber: '' };

// "Nuevo usuario" is an invitation: the person picks their own password.
export function CreateUserModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const invite = useInviteUser();
  const [form, setForm] = useState(emptyForm);
  const [touched, setTouched] = useState(false);
  const [serverErrors, setServerErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(emptyForm);
    setTouched(false);
    setServerErrors({});
    setLink(null);
    setCopied(false);
  }, [open]);

  const errors = { ...validate(form, 'create'), ...serverErrors };
  const set = (p: Partial<Form>) => {
    setForm((f) => ({ ...f, ...p }));
    setServerErrors({});
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(validate(form, 'create')).length) return;
    invite.mutate(
      {
        email: form.email.trim().toLowerCase(),
        role: form.role,
        departmentId: form.departmentId || null,
        canCreateTasks: form.role === 'JEFE_AREA' ? form.canCreateTasks : undefined,
        phoneNumber: form.phoneNumber.trim() ? form.phoneNumber.replace(/\s+/g, '') : null,
      },
      {
        onSuccess: (r) => {
          setLink(r.inviteUrl);
          toast.success(`Invitación enviada a ${form.email.trim()}`);
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === 'USER_EXISTS') setServerErrors({ email: 'Ya tiene una cuenta en este espacio' });
          else if (err instanceof ApiError && err.code === 'USER_DEACTIVATED') setServerErrors({ email: 'Esta cuenta está desactivada: reactívala desde la lista' });
          else toast.error(err instanceof ApiError ? err.message : 'No se pudo invitar');
        },
      },
    );
  };

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link).then(
      () => setCopied(true),
      () => toast.error('No se pudo copiar; selecciona el enlace y cópialo'),
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={link ? 'Invitación creada' : 'Nuevo usuario'}
      description={link ? 'Vale 24 horas. También puedes compartir el enlace por chat.' : 'Invita a una persona a tu espacio de trabajo.'}
      footer={
        link ? (
          <Button onClick={onClose}>Listo</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" form="create-user" loading={invite.isPending}>
              Enviar invitación
            </Button>
          </>
        )
      }
    >
      {link ? (
        <div className="space-y-2">
          <label className="block text-sm font-semibold" htmlFor="invite-link">
            Enlace de invitación
          </label>
          <div className="flex gap-2">
            <Input id="invite-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" variant="secondary" icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />} onClick={() => void copy()}>
              {copied ? 'Copiado' : 'Copiar'}
            </Button>
          </div>
        </div>
      ) : (
        <form id="create-user" noValidate onSubmit={submit}>
          <UserFields form={form} set={set} errors={errors} touched={touched || Object.keys(serverErrors).length > 0} mode="create" />
        </form>
      )}
    </Dialog>
  );
}

export function EditUserModal({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const update = useUpdateUser();
  const [form, setForm] = useState(emptyForm);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!user) return;
    setForm({
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      departmentId: user.departmentId ?? '',
      canCreateTasks: user.canCreateTasks,
      phoneNumber: user.phoneNumber ?? '',
    });
    setTouched(false);
  }, [user]);

  const errors = validate(form, 'edit');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!user || Object.keys(errors).length) return;
    update.mutate(
      {
        id: user.id,
        patch: {
          displayName: form.displayName.trim(),
          role: form.role,
          departmentId: form.departmentId || null,
          ...(form.role === 'JEFE_AREA' ? { canCreateTasks: form.canCreateTasks } : {}),
          phoneNumber: form.phoneNumber.trim() ? form.phoneNumber.replace(/\s+/g, '') : null,
        },
      },
      {
        onSuccess: () => {
          toast.success('Usuario actualizado');
          onClose();
        },
        onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar'),
      },
    );
  };

  return (
    <Dialog
      open={!!user}
      onClose={onClose}
      title="Editar usuario"
      description={user?.email}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="edit-user" loading={update.isPending}>
            Guardar cambios
          </Button>
        </>
      }
    >
      <form id="edit-user" noValidate onSubmit={submit}>
        <UserFields form={form} set={(p) => setForm((f) => ({ ...f, ...p }))} errors={errors} touched={touched} mode="edit" />
      </form>
    </Dialog>
  );
}
