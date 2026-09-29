import clsx from 'clsx';
import { File as FileIcon, FileArchive, FileImage, FileSpreadsheet, FileText, FileVideo, Paperclip, Trash2, Upload } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { formatDateTime } from '../../../lib/format';
import { fetchDownloadUrl, useDeleteTaskFile, useUploadTaskFile } from '../../../lib/queries';
import type { TaskFile } from '../../../lib/types';
import { useAuth } from '../../../stores/auth';
import { toast } from '../../../stores/toast';

// Same rules as the API (it re-checks the real content too).
export const ALLOWED_EXTENSIONS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'gif', 'mp4', 'zip'];
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES = 10;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Returns an error message, or null when the file can be uploaded.
export function validateFile(file: File, currentCount: number): string | null {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (!ALLOWED_EXTENSIONS.includes(ext)) return `"${file.name}": tipo no permitido. Usa ${ALLOWED_EXTENSIONS.join(', ')}.`;
  if (file.size > MAX_FILE_BYTES) return `"${file.name}" pesa ${formatBytes(file.size)}; el máximo es 50 MB.`;
  if (file.size === 0) return `"${file.name}" está vacío.`;
  if (currentCount >= MAX_FILES) return `Una tarea admite como máximo ${MAX_FILES} archivos.`;
  return null;
}

function iconFor(mime: string) {
  if (mime.startsWith('image/')) return FileImage;
  if (mime.startsWith('video/')) return FileVideo;
  if (mime.includes('zip')) return FileArchive;
  if (mime.includes('sheet') || mime.includes('excel')) return FileSpreadsheet;
  if (mime.includes('pdf') || mime.includes('word')) return FileText;
  return FileIcon;
}

function FileRow({ file, taskId, canDelete }: { file: TaskFile; taskId: string; canDelete: boolean }) {
  const user = useAuth((s) => s.user)!;
  const del = useDeleteTaskFile(taskId);
  const [downloading, setDownloading] = useState(false);
  const Icon = iconFor(file.mimeType);

  const download = async () => {
    setDownloading(true);
    try {
      // Served as an attachment, so this downloads without leaving the page.
      window.location.href = await fetchDownloadUrl(taskId, file.id);
    } catch {
      toast.error('No se pudo descargar el archivo');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <li className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-paper">
      <Icon className="size-5 shrink-0 text-ink-soft" aria-hidden />
      <div className="min-w-0 flex-1">
        <button onClick={() => void download()} disabled={downloading} className="block max-w-full truncate text-left text-sm font-semibold text-brand hover:underline disabled:opacity-60">
          {file.originalFilename}
        </button>
        <p className="truncate text-xs text-muted">
          {formatBytes(file.fileSize)} · {file.user.name} · {formatDateTime(file.uploadedAt, user.timezone)}
        </p>
      </div>
      {canDelete && (
        <button
          onClick={() => del.mutate(file.id, { onSuccess: () => toast.success('Archivo eliminado') })}
          disabled={del.isPending}
          className="rounded p-1.5 text-muted opacity-100 hover:bg-sem-red-soft hover:text-sem-red sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
          aria-label={`Eliminar ${file.originalFilename}`}
        >
          <Trash2 className="size-4" />
        </button>
      )}
    </li>
  );
}

export function FilesSection({ taskId, files, canAddFiles }: { taskId: string; files: TaskFile[]; canAddFiles: boolean }) {
  const user = useAuth((s) => s.user)!;
  const upload = useUploadTaskFile(taskId);
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);

  const send = async (list: FileList | File[]) => {
    let count = files.length;
    for (const file of Array.from(list)) {
      const error = validateFile(file, count);
      if (error) {
        toast.error(error);
        continue;
      }
      count++;
      setUploading((n) => n + 1);
      upload.mutate(file, {
        onSuccess: () => toast.success(`"${file.name}" subido`),
        onSettled: () => setUploading((n) => n - 1),
      });
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) void send(e.dataTransfer.files);
  };

  return (
    <section aria-labelledby="files-heading" className="space-y-2">
      <h3 id="files-heading" className="flex items-center gap-2 text-sm font-bold">
        <Paperclip className="size-4 text-muted" aria-hidden /> Archivos
        <span className="font-normal text-muted">
          {files.length}/{MAX_FILES}
        </span>
      </h3>

      {canAddFiles && files.length < MAX_FILES && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={clsx(
            'flex flex-col items-center gap-1 rounded-xl border-2 border-dashed px-4 py-4 text-center text-sm transition',
            dragging ? 'border-brand bg-brand/5' : 'border-line-strong',
          )}
        >
          <Upload className="size-5 text-muted" aria-hidden />
          <p className="text-ink-soft">
            Arrastra archivos aquí o{' '}
            <button type="button" onClick={() => input.current?.click()} className="font-semibold text-brand hover:underline">
              elige uno
            </button>
          </p>
          <p className="text-xs text-muted">PDF, Word, Excel, imágenes, MP4 o ZIP · hasta 50 MB</p>
          {uploading > 0 && <p role="status" className="text-xs font-semibold text-brand">Subiendo {uploading}…</p>}
          <input
            ref={input}
            type="file"
            multiple
            hidden
            accept={ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(',')}
            onChange={(e) => {
              if (e.target.files?.length) void send(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      )}

      {files.length === 0 ? (
        !canAddFiles && <p className="rounded-lg bg-paper px-3 py-4 text-center text-sm text-muted">Sin archivos adjuntos.</p>
      ) : (
        <ul className="-mx-2">
          {files.map((f) => (
            <FileRow key={f.id} file={f} taskId={taskId} canDelete={f.uploadedBy === user.id || user.role === 'ADMIN'} />
          ))}
        </ul>
      )}
    </section>
  );
}
