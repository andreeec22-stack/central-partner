import clsx from 'clsx';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { initials } from '../../../lib/format';
import { ROLE_LABEL } from '../../../lib/labels';
import { filterMentionables, mentionQueryAt } from '../../../lib/mentions';
import type { Mentionable } from '../../../lib/types';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  people: Mentionable[];
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  label: string;
}

// Textarea with @mention autocomplete (ARIA combobox). Typing "@" opens the
// list; ↑/↓ move, Enter/Tab insert, Esc closes. Ctrl/⌘+Enter submits.
export function MentionTextarea({ value, onChange, onSubmit, people, placeholder, disabled, autoFocus, label }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [query, setQuery] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);

  const options = useMemo(() => (query ? filterMentionables(people, query.query) : []), [people, query]);
  const open = options.length > 0;

  const sync = (text: string, caret: number) => {
    setQuery(mentionQueryAt(text, caret));
    setActive(0);
  };

  const pick = (person: Mentionable) => {
    if (!query) return;
    const caret = ref.current?.selectionStart ?? value.length;
    const next = `${value.slice(0, query.start)}@${person.handle} ${value.slice(caret)}`;
    onChange(next);
    setQuery(null);
    const pos = query.start + person.handle.length + 2;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(options[active]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // don't close the panel
        setQuery(null);
        return;
      }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        aria-label={label}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        autoFocus={autoFocus}
        disabled={disabled}
        value={value}
        maxLength={5000}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          sync(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onClick={(e) => sync(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setQuery(null), 120)}
        rows={3}
        className="min-h-20 w-full resize-y rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:bg-sunken"
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Personas para mencionar"
          className="absolute inset-x-0 top-full z-10 mt-1 max-h-60 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-pop"
        >
          {options.map((p, i) => (
            <li
              key={p.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault(); // keep focus in the textarea
                pick(p);
              }}
              onMouseEnter={() => setActive(i)}
              className={clsx('flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm', i === active && 'bg-sunken')}
            >
              <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-navy text-[10px] font-bold text-white">
                {initials(p.displayName)}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <span className="font-semibold">{p.displayName}</span> <span className="text-muted">@{p.handle}</span>
              </span>
              <span className="text-xs text-muted">{ROLE_LABEL[p.role]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
