import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AdminPageHeader } from '../../components/admin/AdminKit';
import { Button } from '../../components/ui/Button';
import { ErrorNotice, Skeleton } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { ApiError } from '../../lib/api';
import { useUpdateWorkspace, useWorkspaceConfig, type WorkspaceConfig } from '../../lib/admin';
import { toast } from '../../stores/toast';
import { BrandingSection } from './BrandingPage';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Common zones first; the full IANA list after.
const COMMON_ZONES = ['America/Lima', 'America/Bogota', 'America/Mexico_City', 'America/Santiago', 'America/Argentina/Buenos_Aires', 'America/Caracas', 'Europe/Madrid'];

function zoneLabel(tz: string) {
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value;
  return `${tz.split('/').pop()!.replace(/_/g, ' ')} (${offset?.replace('GMT', 'UTC') || 'UTC'})`;
}

function GeneralForm({ ws }: { ws: WorkspaceConfig }) {
  const update = useUpdateWorkspace();
  const [contactEmail, setContactEmail] = useState(ws.contactEmail ?? '');
  const [timezone, setTimezone] = useState(ws.timezone);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    setContactEmail(ws.contactEmail ?? '');
    setTimezone(ws.timezone);
  }, [ws]);

  const zones = useMemo(() => {
    const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    const rest = all.filter((z) => !COMMON_ZONES.includes(z));
    return { common: COMMON_ZONES.includes(ws.timezone) || !ws.timezone ? COMMON_ZONES : [ws.timezone, ...COMMON_ZONES], rest };
  }, [ws.timezone]);

  const emailError = contactEmail.trim() && !EMAIL.test(contactEmail.trim()) ? 'Escribe un correo válido' : undefined;
  const dirty = (contactEmail.trim() || null) !== ws.contactEmail || timezone !== ws.timezone;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (emailError) return;
    update.mutate(
      { contactEmail: contactEmail.trim() || null, timezone },
      {
        onSuccess: () => toast.success('Configuración guardada'),
        onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar'),
      },
    );
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4 rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
      <h2 className="font-bold">General</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email de contacto" error={touched || contactEmail ? emailError : undefined} hint="Opcional. Dónde escribir a la empresa.">
          {(id, d) => (
            <Input id={id} aria-describedby={d} type="email" value={contactEmail} maxLength={254} invalid={!!emailError} placeholder="director@empresa.com" onChange={(e) => setContactEmail(e.target.value)} />
          )}
        </Field>
        <Field label="Zona horaria" hint="Define cuándo empieza la semana (lunes) y qué es “hoy” para el semáforo.">
          {(id, d) => (
            <Select id={id} aria-describedby={d} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              <optgroup label="Frecuentes">
                {zones.common.map((z) => (
                  <option key={z} value={z}>
                    {zoneLabel(z)}
                  </option>
                ))}
              </optgroup>
              {zones.rest.length > 0 && (
                <optgroup label="Todas">
                  {zones.rest.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          )}
        </Field>
      </div>
      {timezone !== ws.timezone && (
        <p className="rounded-lg bg-sem-yellow-soft px-3 py-2 text-xs text-ink-soft">Cambiar la zona horaria mueve el inicio de las semanas y el cálculo de atrasos para todos.</p>
      )}
      <div className="flex justify-end border-t border-line pt-4">
        <Button type="submit" loading={update.isPending} disabled={!dirty}>
          Guardar cambios
        </Button>
      </div>
    </form>
  );
}

export default function WorkspaceSettingsPage() {
  const ws = useWorkspaceConfig();
  return (
    <div className="space-y-6">
      <AdminPageHeader section="Settings" title="Configuración del espacio" description="Datos de la empresa, zona horaria, logo y colores." />
      {ws.isError ? <ErrorNotice message="No pudimos cargar la configuración." onRetry={() => void ws.refetch()} /> : !ws.data ? <Skeleton className="h-48 w-full" /> : <GeneralForm ws={ws.data} />}
      <section aria-labelledby="brand-heading" className="space-y-3">
        <h2 id="brand-heading" className="text-lg font-bold">
          Marca
        </h2>
        <BrandingSection />
      </section>
    </div>
  );
}
