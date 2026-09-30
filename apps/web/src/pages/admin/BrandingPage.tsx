import clsx from 'clsx';
import { ImageUp, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { BrandMark } from '../../components/layout/BrandMark';
import { Button } from '../../components/ui/Button';
import { ErrorNotice, Skeleton } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { ApiError } from '../../lib/api';
import { useBranding, useRemoveLogo, useUpdateBranding, useUploadLogo } from '../../lib/queries';
import type { BrandColors, Branding } from '../../lib/types';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/toast';

const COLOR_FIELDS: { key: keyof BrandColors; label: string; hint: string }[] = [
  { key: 'primary', label: 'Principal', hint: 'Botones, enlaces y foco' },
  { key: 'success', label: 'Éxito', hint: 'Confirmaciones' },
  { key: 'warning', label: 'Advertencia', hint: 'Avisos' },
  { key: 'danger', label: 'Peligro', hint: 'Errores y borrados' },
];

const DEFAULT_COLORS: BrandColors = { primary: '#2563EB', success: '#10B981', warning: '#F59E0B', danger: '#EF4444' };
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml'];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const HEX = /^#[0-9a-f]{6}$/i;

// WCAG relative luminance → is white text readable on this color?
function contrastWithWhite(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return 1.05 / (l + 0.05);
}

function ColorField({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const invalid = !HEX.test(text);
  return (
    <Field label={label} hint={hint} error={invalid ? 'Usa un color como #2563EB' : undefined}>
      {(id, describedBy) => (
        <div className="flex items-center gap-2">
          <input type="color" aria-label={`${label} (selector)`} value={HEX.test(value) ? value : '#000000'} onChange={(e) => onChange(e.target.value.toUpperCase())} className="h-10 w-12 cursor-pointer rounded-lg border border-line-strong bg-surface p-1" />
          <Input
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            value={text}
            maxLength={7}
            className="font-mono uppercase"
            onChange={(e) => {
              setText(e.target.value);
              if (HEX.test(e.target.value)) onChange(e.target.value.toUpperCase());
            }}
          />
        </div>
      )}
    </Field>
  );
}

function Preview({ name, tagline, logoUrl, colors }: { name: string; tagline: string; logoUrl: string | null; colors: BrandColors }) {
  const lowContrast = contrastWithWhite(colors.primary) < 4.5;
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold">Vista previa</p>
      <div className="overflow-hidden rounded-2xl border border-line shadow-card">
        <div className="bg-navy px-4 py-4">
          <BrandMark name={name || 'Sin nombre'} tagline={tagline || null} logoUrl={logoUrl} />
        </div>
        <div className="flex flex-wrap items-center gap-2 bg-surface p-4">
          <span className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white" style={{ background: colors.primary }}>
            Nueva tarea
          </span>
          <span className="text-sm font-semibold underline" style={{ color: colors.primary }}>
            Enlace
          </span>
          {(['success', 'warning', 'danger'] as const).map((k) => (
            <span key={k} className="rounded-full px-2.5 py-0.5 text-xs font-semibold text-white" style={{ background: colors[k] }}>
              {k === 'success' ? 'Guardado' : k === 'warning' ? 'Atención' : 'Error'}
            </span>
          ))}
        </div>
      </div>
      {lowContrast && (
        <p className="text-xs font-medium text-sem-yellow">El texto blanco sobre el color principal se lee con dificultad (contraste {contrastWithWhite(colors.primary).toFixed(1)}:1, se recomienda 4.5:1).</p>
      )}
    </div>
  );
}

function LogoUpload({ branding, workspaceId }: { branding: Branding; workspaceId: string }) {
  const upload = useUploadLogo(workspaceId);
  const remove = useRemoveLogo(workspaceId);
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const send = (file: File) => {
    if (!LOGO_TYPES.includes(file.type)) return toast.error('El logo debe ser PNG, JPG o SVG.');
    if (file.size > MAX_LOGO_BYTES) return toast.error('El logo no puede pesar más de 2 MB.');
    // Only a recommendation: warn, don't block.
    if (file.type !== 'image/svg+xml') {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        if (img.width < 200 || img.height < 200 || img.width > 1000 || img.height > 1000) {
          toast.info(`El logo mide ${img.width}×${img.height}px; se recomienda entre 200 y 1000 px por lado.`);
        }
        URL.revokeObjectURL(url);
      };
      img.src = url;
    }
    upload.mutate(file, {
      onSuccess: () => toast.success('Logo actualizado para todo el equipo'),
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'No se pudo subir el logo'),
    });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) send(file);
  };

  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold">Logo</p>
      <div className="flex flex-wrap items-center gap-4">
        <div className="grid size-24 shrink-0 place-items-center overflow-hidden rounded-2xl border border-line bg-paper">
          {branding.logoUrl ? <img src={branding.logoUrl} alt="Logo actual" className="size-full object-contain p-2" /> : <span className="text-xs text-muted">Sin logo</span>}
        </div>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={clsx('flex min-w-60 flex-1 flex-col items-center gap-1 rounded-xl border-2 border-dashed px-4 py-5 text-center text-sm', dragging ? 'border-brand bg-brand/5' : 'border-line-strong')}
        >
          <ImageUp className="size-5 text-muted" aria-hidden />
          <p className="text-ink-soft">
            Arrastra tu logo o{' '}
            <button type="button" className="font-semibold text-brand hover:underline" onClick={() => input.current?.click()}>
              elige un archivo
            </button>
          </p>
          <p className="text-xs text-muted">PNG, JPG o SVG · máx. 2 MB · ideal entre 200 y 1000 px</p>
          {upload.isPending && <p role="status" className="text-xs font-semibold text-brand">Subiendo…</p>}
          <input
            ref={input}
            type="file"
            hidden
            accept=".png,.jpg,.jpeg,.svg"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) send(file);
              e.target.value = '';
            }}
          />
        </div>
      </div>
      {branding.logoUrl && (
        <Button variant="ghost" size="sm" icon={<Trash2 className="size-4" />} loading={remove.isPending} onClick={() => remove.mutate(undefined, { onSuccess: () => toast.success('Logo quitado') })}>
          Quitar logo
        </Button>
      )}
    </div>
  );
}

function BrandingForm({ branding, workspaceId }: { branding: Branding; workspaceId: string }) {
  const update = useUpdateBranding(workspaceId);
  const [name, setName] = useState(branding.workspaceName);
  const [tagline, setTagline] = useState(branding.tagline ?? '');
  const [colors, setColors] = useState(branding.colors);

  // The server version changed (a save, a logo upload, another admin's edit):
  // take the new values only for fields this form hasn't edited, so unsaved
  // changes are never overwritten.
  const previous = useRef(branding);
  useEffect(() => {
    const before = previous.current;
    previous.current = branding;
    if (before === branding) return;
    setName((v) => (v === before.workspaceName ? branding.workspaceName : v));
    setTagline((v) => (v === (before.tagline ?? '') ? (branding.tagline ?? '') : v));
    setColors((c) => {
      const next = { ...c };
      for (const k of Object.keys(c) as (keyof BrandColors)[]) {
        if (c[k].toUpperCase() === before.colors[k].toUpperCase()) next[k] = branding.colors[k];
      }
      return next;
    });
  }, [branding]);

  const dirty =
    name.trim() !== branding.workspaceName ||
    (tagline.trim() || null) !== branding.tagline ||
    (Object.keys(colors) as (keyof BrandColors)[]).some((k) => colors[k].toUpperCase() !== branding.colors[k].toUpperCase());

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return toast.error('El nombre es obligatorio');
    update.mutate(
      { workspaceName: name.trim(), tagline: tagline.trim() || null, colors },
      {
        onSuccess: () => toast.success('Marca guardada; ya se ve en todo el equipo'),
        onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar'),
      },
    );
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
      <form onSubmit={submit} className="space-y-6 rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
        <LogoUpload branding={branding} workspaceId={workspaceId} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre del espacio" hint={`${name.length}/50`}>
            {(id, d) => <Input id={id} aria-describedby={d} value={name} maxLength={50} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Lema (opcional)" hint={`${tagline.length}/100`}>
            {(id, d) => <Input id={id} aria-describedby={d} value={tagline} maxLength={100} onChange={(e) => setTagline(e.target.value)} />}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {COLOR_FIELDS.map((f) => (
            <ColorField key={f.key} label={f.label} hint={f.hint} value={colors[f.key]} onChange={(v) => setColors((c) => ({ ...c, [f.key]: v }))} />
          ))}
        </div>
        <p className="text-xs text-muted">Los colores del semáforo (verde, amarillo, rojo) son fijos y no cambian con la marca.</p>

        <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => setColors(DEFAULT_COLORS)}>
            Colores por defecto
          </Button>
          <Button type="submit" loading={update.isPending} disabled={!dirty}>
            Guardar cambios
          </Button>
        </div>
      </form>

      <aside className="lg:sticky lg:top-20 lg:self-start">
        <Preview name={name} tagline={tagline} logoUrl={branding.logoUrl} colors={colors} />
      </aside>
    </div>
  );
}

// Logo, name, tagline and colors — part of Settings > Workspace.
export function BrandingSection() {
  const workspaceId = useAuth((s) => s.workspace!.id);
  const branding = useBranding(workspaceId);
  if (branding.isError) return <ErrorNotice message="No pudimos cargar la marca." onRetry={() => void branding.refetch()} />;
  if (!branding.data) return <Skeleton className="h-96 w-full" />;
  return <BrandingForm branding={branding.data} workspaceId={workspaceId} />;
}
