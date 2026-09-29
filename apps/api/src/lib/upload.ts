import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AppError, badRequest, validationError } from './errors';
import { detectFileType } from './file-types';

export interface Upload {
  name: string;
  bytes: Uint8Array;
  size: number;
  mimeType: string;
}

const MB = 1024 * 1024;
export const formatMb = (bytes: number) => `${Math.round(bytes / MB)}MB`;

// Rejects oversized bodies while streaming, before anything is buffered.
// The margin covers the multipart envelope around the file itself.
export const uploadLimit = (maxFileBytes: number) =>
  bodyLimit({
    maxSize: maxFileBytes + 64 * 1024,
    onError: () => {
      throw new AppError(413, 'FILE_TOO_LARGE', `File is larger than ${formatMb(maxFileBytes)}`);
    },
  });

// Reads the multipart field `file` and checks size and real type.
export async function readUpload(
  c: Context,
  opts: { maxBytes: number; allowed: Parameters<typeof detectFileType>[2]; allowedLabel: string },
): Promise<Upload> {
  if (!c.req.header('content-type')?.includes('multipart/form-data')) {
    throw badRequest('Send the file as multipart/form-data in a field named "file"');
  }
  const form = await c.req.parseBody().catch(() => {
    throw badRequest('Could not read the uploaded form');
  });
  const file = form.file;
  if (!(file instanceof File)) throw validationError('No file was sent', [{ field: 'file', message: 'required' }]);
  if (file.size === 0) throw validationError('The file is empty', [{ field: 'file', message: 'empty' }]);
  if (file.size > opts.maxBytes) {
    throw new AppError(413, 'FILE_TOO_LARGE', `File is larger than ${formatMb(opts.maxBytes)}`);
  }
  const name = (file.name || 'file').slice(-255);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = detectFileType(name, bytes.subarray(0, 4096), opts.allowed);
  if (!mimeType) {
    throw validationError(`File type not allowed. Allowed: ${opts.allowedLabel}`, [{ field: 'file', message: 'type not allowed' }]);
  }
  return { name, bytes, size: file.size, mimeType };
}
