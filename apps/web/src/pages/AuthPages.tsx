import { ArrowRight, CircleCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { Button } from '../components/ui/Button';
import { ErrorNotice, Spinner } from '../components/ui/Feedback';
import { Field, Input } from '../components/ui/Field';
import { api, ApiError } from '../lib/api';
import { ROLE_LABEL } from '../lib/labels';
import type { AuthPayload, Role, Workspace } from '../lib/types';
import { useAuth } from '../stores/auth';

// ─── Layout ─────────────────────────────────────────────────────────────────

function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-navy p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-2.5 text-lg font-extrabold tracking-tight">
          <span className="flex gap-1">
            <span className="size-2.5 rounded-full bg-sem-green" />
            <span className="size-2.5 rounded-full bg-sem-yellow" />
            <span className="size-2.5 rounded-full bg-sem-red" />
          </span>
          Central Partner
        </div>
        <div className="max-w-md">
          <p className="text-4xl font-extrabold leading-[1.1] tracking-tight">Tres cosas al día. Todo el equipo, en un solo lugar.</p>
          <ol className="mt-8 space-y-3 text-white/80">
            {['Escribe tus tareas de la semana', 'Marca el avance: 0 · 25 · 50 · 75 · 100 %', 'El sábado, registra el resultado real'].map((t, i) => (
              <li key={t} className="flex items-center gap-3">
                <span className="grid size-7 place-items-center rounded-full bg-white/10 font-mono text-sm">{i + 1}</span>
                {t}
              </li>
            ))}
          </ol>
        </div>
        <p className="text-sm text-white/50">El semáforo se calcula solo.</p>
        {/* Decorative semaphore rings */}
        <div aria-hidden className="pointer-events-none absolute -right-24 top-1/3 flex flex-col gap-6 opacity-20">
          <span className="size-40 rounded-full border-[14px] border-sem-green" />
          <span className="size-40 rounded-full border-[14px] border-sem-yellow" />
          <span className="size-40 rounded-full border-[14px] border-sem-red" />
        </div>
      </aside>
      <main className="flex items-center justify-center px-4 py-12 sm:px-8">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-8 text-center text-sm text-muted">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

const linkClass = 'font-semibold text-brand hover:underline';

function useFormErrors() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const capture = (err: unknown) => {
    if (err instanceof ApiError) {
      const fe = err.fieldErrors;
      setErrors(Object.keys(fe).length ? fe : { form: err.message });
    } else setErrors({ form: 'No pudimos conectar con el servidor. Intenta de nuevo.' });
  };
  return { errors, setErrors, capture };
}

// ─── Login ──────────────────────────────────────────────────────────────────

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const signIn = useAuth((s) => s.signIn);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { errors, setErrors, capture } = useFormErrors();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  async function submit(workspaceId?: string) {
    setBusy(true);
    setErrors({});
    try {
      const res = await api<AuthPayload>('/auth/login', { method: 'POST', body: { email, password, workspaceId }, skipAuthRetry: true });
      signIn(res);
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'WORKSPACE_SELECTION_REQUIRED') {
        setWorkspaces((err.details as { workspaces: Workspace[] }).workspaces);
      } else capture(err);
    } finally {
      setBusy(false);
    }
  }

  if (workspaces) {
    return (
      <AuthLayout title="Elige tu espacio de trabajo" subtitle="Tu correo pertenece a varias empresas.">
        <ul className="space-y-2">
          {workspaces.map((w) => (
            <li key={w.id}>
              <button
                onClick={() => void submit(w.id)}
                disabled={busy}
                className="flex w-full items-center justify-between rounded-xl border border-line-strong bg-surface px-4 py-3 text-left font-semibold hover:border-brand"
              >
                {w.name}
                <ArrowRight className="size-4 text-muted" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
        <button onClick={() => setWorkspaces(null)} className={`${linkClass} mt-6 text-sm`}>
          Volver
        </button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Inicia sesión"
      subtitle="Bienvenido de vuelta."
      footer={
        <>
          ¿Eres el director y aún no tienes cuenta?{' '}
          <Link to="/register" className={linkClass}>
            Crea tu espacio
          </Link>
        </>
      }
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void submit();
        }}
      >
        {errors.form && <ErrorNotice message={errors.form} />}
        <Field label="Correo" error={errors.email}>
          {(id, d) => <Input id={id} aria-describedby={d} type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} invalid={!!errors.email} />}
        </Field>
        <Field label="Contraseña" error={errors.password}>
          {(id, d) => (
            <Input id={id} aria-describedby={d} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} invalid={!!errors.password} />
          )}
        </Field>
        <div className="flex justify-end">
          <Link to="/forgot-password" className={`${linkClass} text-sm`}>
            ¿Olvidaste tu contraseña?
          </Link>
        </div>
        <Button type="submit" className="w-full" loading={busy}>
          Entrar
        </Button>
      </form>
    </AuthLayout>
  );
}

// ─── Register (the director creates the workspace — Confirmación B) ─────────

export function RegisterPage() {
  const navigate = useNavigate();
  const signIn = useAuth((s) => s.signIn);
  const [form, setForm] = useState({ workspaceName: '', displayName: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const { errors, setErrors, capture } = useFormErrors();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    if (form.password.length < 8) return setErrors({ password: 'Usa al menos 8 caracteres' });
    setBusy(true);
    try {
      const res = await api<AuthPayload>('/auth/register', {
        method: 'POST',
        body: { ...form, displayName: form.displayName || undefined },
        skipAuthRetry: true,
      });
      signIn(res);
      navigate('/', { replace: true });
    } catch (err) {
      capture(err);
    } finally {
      setBusy(false);
    }
  }

  const bind = (k: keyof typeof form) => ({ value: form[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value })) });

  return (
    <AuthLayout
      title="Crea el espacio de tu empresa"
      subtitle="Serás el director (administrador). Luego invitas a tu equipo."
      footer={
        <>
          ¿Ya tienes cuenta?{' '}
          <Link to="/login" className={linkClass}>
            Inicia sesión
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={submit} noValidate>
        {errors.form && <ErrorNotice message={errors.form} />}
        <Field label="Nombre de la empresa" error={errors.workspaceName}>
          {(id, d) => <Input id={id} aria-describedby={d} maxLength={50} required autoFocus invalid={!!errors.workspaceName} {...bind('workspaceName')} />}
        </Field>
        <Field label="Tu nombre" error={errors.displayName}>
          {(id, d) => <Input id={id} aria-describedby={d} autoComplete="name" maxLength={100} {...bind('displayName')} />}
        </Field>
        <Field label="Correo" error={errors.email}>
          {(id, d) => <Input id={id} aria-describedby={d} type="email" autoComplete="email" required invalid={!!errors.email} {...bind('email')} />}
        </Field>
        <Field label="Contraseña" error={errors.password} hint="Mínimo 8 caracteres">
          {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" required invalid={!!errors.password} {...bind('password')} />}
        </Field>
        <Button type="submit" className="w-full" loading={busy}>
          Crear espacio
        </Button>
      </form>
    </AuthLayout>
  );
}

// ─── Forgot / reset password ────────────────────────────────────────────────

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const { errors, setErrors, capture } = useFormErrors();

  return (
    <AuthLayout
      title="Recupera tu contraseña"
      subtitle="Te enviaremos un enlace válido por 1 hora."
      footer={
        <Link to="/login" className={linkClass}>
          Volver a iniciar sesión
        </Link>
      }
    >
      {sent ? (
        <div className="flex gap-3 rounded-xl border border-sem-green/30 bg-sem-green-soft p-4 text-sm">
          <CircleCheck className="size-5 shrink-0 text-sem-green" aria-hidden />
          <p>Si existe una cuenta con <strong>{email}</strong>, recibirás un correo con el enlace en unos minutos.</p>
        </div>
      ) : (
        <form
          className="space-y-4"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            setErrors({});
            setBusy(true);
            try {
              await api('/auth/reset-password', { method: 'POST', body: { email }, skipAuthRetry: true });
              setSent(true);
            } catch (err) {
              capture(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          {errors.form && <ErrorNotice message={errors.form} />}
          <Field label="Correo" error={errors.email}>
            {(id, d) => <Input id={id} aria-describedby={d} type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} invalid={!!errors.email} />}
          </Field>
          <Button type="submit" className="w-full" loading={busy}>
            Enviar enlace
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const { errors, setErrors, capture } = useFormErrors();
  const logoutLocal = () => useAuth.setState({ status: 'anonymous', accessToken: null, user: null, workspace: null });

  return (
    <AuthLayout title="Nueva contraseña" subtitle="Al cambiarla se cerrará tu sesión en todos los dispositivos.">
      {!token ? (
        <ErrorNotice message="El enlace está incompleto. Pide uno nuevo." />
      ) : done ? (
        <div className="space-y-6">
          <div className="flex gap-3 rounded-xl border border-sem-green/30 bg-sem-green-soft p-4 text-sm">
            <CircleCheck className="size-5 shrink-0 text-sem-green" aria-hidden />
            <p>Listo. Ya puedes entrar con tu nueva contraseña.</p>
          </div>
          <Link to="/login" className={linkClass}>
            Ir a iniciar sesión
          </Link>
        </div>
      ) : (
        <form
          className="space-y-4"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            setErrors({});
            if (password.length < 8) return setErrors({ newPassword: 'Usa al menos 8 caracteres' });
            setBusy(true);
            try {
              await api('/auth/reset-password/confirm', { method: 'POST', body: { token, newPassword: password }, skipAuthRetry: true });
              logoutLocal();
              setDone(true);
            } catch (err) {
              capture(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          {(errors.form || errors.token) && <ErrorNotice message={errors.token ? 'Este enlace ya no es válido. Pide uno nuevo.' : errors.form!} />}
          <Field label="Nueva contraseña" error={errors.newPassword} hint="Mínimo 8 caracteres">
            {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} invalid={!!errors.newPassword} />}
          </Field>
          <Button type="submit" className="w-full" loading={busy}>
            Guardar contraseña
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

// ─── Accept invitation (Confirmación D, 24 h link) ──────────────────────────

interface InvitationInfo {
  email: string;
  role: Role;
  workspaceName: string;
  expiresAt: string;
}

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const signIn = useAuth((s) => s.signIn);
  const [info, setInfo] = useState<InvitationInfo | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [form, setForm] = useState({ displayName: '', password: '' });
  const [busy, setBusy] = useState(false);
  const { errors, setErrors, capture } = useFormErrors();

  useEffect(() => {
    if (!token) return setInvalid(true);
    api<InvitationInfo>('/users/accept-invite', { query: { token }, skipAuthRetry: true })
      .then(setInfo)
      .catch(() => setInvalid(true));
  }, [token]);

  if (invalid) {
    return (
      <AuthLayout title="Invitación no válida">
        <ErrorNotice message="El enlace expiró o ya se usó. Pide al director que te invite de nuevo." />
      </AuthLayout>
    );
  }
  if (!info) {
    return (
      <AuthLayout title="Revisando tu invitación…">
        <Spinner />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={`Únete a ${info.workspaceName}`} subtitle={<>Entrarás como <strong>{ROLE_LABEL[info.role]}</strong> con {info.email}.</>}>
      <form
        className="space-y-4"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setErrors({});
          if (!form.displayName.trim()) return setErrors({ displayName: 'Escribe tu nombre' });
          if (form.password.length < 8) return setErrors({ password: 'Usa al menos 8 caracteres' });
          setBusy(true);
          try {
            const res = await api<AuthPayload>('/users/accept-invite', { method: 'POST', body: { token, ...form }, skipAuthRetry: true });
            signIn(res);
            navigate('/', { replace: true });
          } catch (err) {
            capture(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        {errors.form && <ErrorNotice message={errors.form} />}
        <Field label="Tu nombre" error={errors.displayName}>
          {(id, d) => <Input id={id} aria-describedby={d} autoComplete="name" autoFocus maxLength={100} value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} invalid={!!errors.displayName} />}
        </Field>
        <Field label="Crea una contraseña" error={errors.password} hint="Mínimo 8 caracteres">
          {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} invalid={!!errors.password} />}
        </Field>
        <Button type="submit" className="w-full" loading={busy}>
          Unirme
        </Button>
      </form>
    </AuthLayout>
  );
}
