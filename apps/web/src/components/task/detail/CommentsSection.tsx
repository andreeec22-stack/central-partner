import { MessageSquare, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { formatDateTime, initials, relativeTime } from '../../../lib/format';
import { splitMentions } from '../../../lib/mentions';
import { useAddComment, useDeleteComment, useEditComment, useMentionable } from '../../../lib/queries';
import type { Comment } from '../../../lib/types';
import { useAuth } from '../../../stores/auth';
import { Button } from '../../ui/Button';
import { MentionTextarea } from './MentionTextarea';

function CommentBody({ comment }: { comment: Comment }) {
  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">
      {splitMentions(comment.content, comment.mentionedUsers).map((part, i) =>
        part.kind === 'mention' ? (
          <span key={i} title={part.user.displayName} className="rounded-full bg-brand/10 px-1.5 py-px font-semibold text-brand">
            @{part.user.displayName}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </p>
  );
}

function CommentItem({ comment, taskId, canManage }: { comment: Comment; taskId: string; canManage: boolean }) {
  const user = useAuth((s) => s.user)!;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.content);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const edit = useEditComment(taskId);
  const del = useDeleteComment(taskId);
  const people = useMentionable(taskId, editing);

  const save = () => {
    const content = draft.trim();
    if (!content || content === comment.content) return setEditing(false);
    edit.mutate({ id: comment.id, content }, { onSuccess: () => setEditing(false) });
  };

  return (
    <li className="flex gap-3">
      <span aria-hidden className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-navy text-xs font-bold text-white">
        {initials(comment.user.name)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-bold">{comment.user.name}</span>
          <time dateTime={comment.createdAt} title={formatDateTime(comment.createdAt, user.timezone)} className="text-xs text-muted">
            {relativeTime(comment.createdAt)}
          </time>
          {comment.editedAt && <span className="text-xs text-muted">(editado)</span>}
          {canManage && !editing && (
            <span className="ml-auto flex gap-0.5">
              <button
                onClick={() => {
                  setDraft(comment.content);
                  setEditing(true);
                }}
                className="rounded p-1 text-muted hover:bg-sunken hover:text-ink"
                aria-label="Editar comentario"
              >
                <Pencil className="size-3.5" />
              </button>
              <button onClick={() => setConfirmDelete(true)} className="rounded p-1 text-muted hover:bg-sem-red-soft hover:text-sem-red" aria-label="Borrar comentario">
                <Trash2 className="size-3.5" />
              </button>
            </span>
          )}
        </div>
        {editing ? (
          <div className="mt-1.5 space-y-2">
            <MentionTextarea label="Editar comentario" value={draft} onChange={setDraft} onSubmit={save} people={people.data ?? []} autoFocus />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
                Cancelar
              </Button>
              <Button size="sm" loading={edit.isPending} onClick={save}>
                Guardar
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-0.5">
            <CommentBody comment={comment} />
          </div>
        )}
        {confirmDelete && (
          <div role="alert" className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-sem-red-soft px-3 py-2 text-xs text-sem-red">
            ¿Borrar este comentario?
            <span className="flex gap-2">
              <button className="font-semibold text-ink-soft hover:underline" onClick={() => setConfirmDelete(false)}>
                No
              </button>
              <button className="font-bold hover:underline" disabled={del.isPending} onClick={() => del.mutate(comment.id)}>
                Sí, borrar
              </button>
            </span>
          </div>
        )}
      </div>
    </li>
  );
}

export function CommentsSection({ taskId, comments, canComment }: { taskId: string; comments: Comment[]; canComment: boolean }) {
  const user = useAuth((s) => s.user)!;
  const [draft, setDraft] = useState('');
  const add = useAddComment(taskId);
  const people = useMentionable(taskId, canComment);

  const submit = () => {
    const content = draft.trim();
    if (!content || add.isPending) return;
    add.mutate(content, { onSuccess: () => setDraft('') });
  };

  return (
    <section aria-labelledby="comments-heading" className="space-y-3">
      <h3 id="comments-heading" className="flex items-center gap-2 text-sm font-bold">
        <MessageSquare className="size-4 text-muted" aria-hidden /> Comentarios
        <span className="font-normal text-muted">{comments.length}</span>
      </h3>

      {canComment && (
        <div className="space-y-2">
          <MentionTextarea
            label="Nuevo comentario"
            value={draft}
            onChange={setDraft}
            onSubmit={submit}
            people={people.data ?? []}
            placeholder="Escribe un comentario… usa @ para mencionar"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted">Ctrl + Enter para enviar</span>
            <Button size="sm" onClick={submit} loading={add.isPending} disabled={!draft.trim()}>
              Comentar
            </Button>
          </div>
        </div>
      )}

      {comments.length === 0 ? (
        <p className="rounded-lg bg-paper px-3 py-4 text-center text-sm text-muted">Aún no hay comentarios.</p>
      ) : (
        <ul className="space-y-4">
          {comments.map((c) => (
            <CommentItem key={c.id} comment={c} taskId={taskId} canManage={c.userId === user.id || user.role === 'ADMIN'} />
          ))}
        </ul>
      )}
    </section>
  );
}
