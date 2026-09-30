import clsx from 'clsx';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { ROLE_LABEL } from '../../lib/labels';
import type { Role } from '../../lib/types';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

// Small shared pieces of the back office pages.

export function AdminPageHeader({ section, title, description, actions }: { section?: string; title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="flex items-center gap-1 text-xs font-bold uppercase tracking-widest text-muted">
          Administración
          {section && (
            <>
              <ChevronRight className="size-3" aria-hidden /> {section}
            </>
          )}
        </p>
        <h1 className="mt-1 text-2xl font-extrabold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

const roleTone: Record<Role, string> = {
  ADMIN: 'bg-navy text-white',
  JEFE_AREA: 'bg-brand/10 text-brand',
  USER: 'bg-sunken text-ink-soft',
  VIEWER: 'bg-paper text-muted ring-1 ring-line',
};

export function RoleBadge({ role }: { role: Role }) {
  return <span className={clsx('inline-flex rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap', roleTone[role])}>{ROLE_LABEL[role]}</span>;
}

export function StatusBadge({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap',
        active ? 'bg-sem-green-soft text-sem-green' : 'bg-sunken text-muted',
      )}
    >
      <span aria-hidden className={clsx('size-1.5 rounded-full', active ? 'bg-sem-green' : 'bg-muted')} />
      {children}
    </span>
  );
}

export function Pagination({ page, total, pageSize, onPage, label }: { page: number; total: number; pageSize: number; onPage: (p: number) => void; label: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <nav aria-label={`Paginación de ${label}`} className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
      <span className="tabular">
        {from}–{to} de {total}
      </span>
      {pages > 1 && (
        <span className="flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            Anterior
          </Button>
          <span className="tabular">
            {page} / {pages}
          </span>
          <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
            Siguiente
          </Button>
        </span>
      )}
    </nav>
  );
}

// Confirmation before anything destructive.
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  danger = true,
  loading,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children ?? <p className="text-sm text-ink-soft">Esta acción queda registrada en la auditoría.</p>}
    </Dialog>
  );
}

// Table shell shared by the admin lists: scrolls sideways on phones.
export function AdminTable({ caption, head, children, minWidth = '48rem' }: { caption: string; head: ReactNode; children: ReactNode; minWidth?: string }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-card">
      <table className="w-full text-sm" style={{ minWidth }}>
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-line bg-paper/70 text-left text-xs font-semibold uppercase tracking-wide text-muted">{head}</thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

export const th = 'px-4 py-2.5 whitespace-nowrap';
export const td = 'px-4 py-3';
