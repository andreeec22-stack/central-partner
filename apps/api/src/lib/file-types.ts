// Upload allow-lists. The extension decides the type; the file's first bytes
// must agree, so a renamed .exe (or an HTML page called report.pdf) is refused.
// The browser-supplied Content-Type is never trusted.

interface FileKind {
  mime: string;
  matches: (head: Uint8Array) => boolean;
}

const startsWith = (head: Uint8Array, bytes: number[], offset = 0) => bytes.every((b, i) => head[offset + i] === b);

const PDF = (h: Uint8Array) => startsWith(h, [0x25, 0x50, 0x44, 0x46]); // %PDF
const PNG = (h: Uint8Array) => startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = (h: Uint8Array) => startsWith(h, [0xff, 0xd8, 0xff]);
const GIF = (h: Uint8Array) => startsWith(h, [0x47, 0x49, 0x46, 0x38]); // GIF8
const ZIP = (h: Uint8Array) => startsWith(h, [0x50, 0x4b, 0x03, 0x04]) || startsWith(h, [0x50, 0x4b, 0x05, 0x06]); // docx/xlsx too
const OLE = (h: Uint8Array) => startsWith(h, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // legacy .doc/.xls
const MP4 = (h: Uint8Array) => startsWith(h, [0x66, 0x74, 0x79, 0x70], 4); // ....ftyp

export const TASK_FILE_TYPES: Record<string, FileKind> = {
  pdf: { mime: 'application/pdf', matches: PDF },
  doc: { mime: 'application/msword', matches: OLE },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', matches: ZIP },
  xls: { mime: 'application/vnd.ms-excel', matches: OLE },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', matches: ZIP },
  png: { mime: 'image/png', matches: PNG },
  jpg: { mime: 'image/jpeg', matches: JPEG },
  jpeg: { mime: 'image/jpeg', matches: JPEG },
  gif: { mime: 'image/gif', matches: GIF },
  mp4: { mime: 'video/mp4', matches: MP4 },
  zip: { mime: 'application/zip', matches: ZIP },
};

export const EXCEL_FILE_TYPES: Record<string, FileKind> = { xlsx: TASK_FILE_TYPES.xlsx! };

const SVG = (h: Uint8Array) => /<svg[\s>]/i.test(new TextDecoder().decode(h.subarray(0, 1024)));

export const LOGO_FILE_TYPES: Record<string, FileKind> = {
  png: TASK_FILE_TYPES.png!,
  jpg: TASK_FILE_TYPES.jpg!,
  jpeg: TASK_FILE_TYPES.jpeg!,
  svg: { mime: 'image/svg+xml', matches: SVG },
};

export const extensionOf = (filename: string) => filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';

// Returns the canonical MIME type, or null when the file isn't one of `allowed`.
export function detectFileType(filename: string, head: Uint8Array, allowed: Record<string, FileKind>): string | null {
  const kind = allowed[extensionOf(filename)];
  return kind && kind.matches(head) ? kind.mime : null;
}

// Logos are shown through <img>, where SVG scripts don't run — but someone could
// open the URL directly. Refuse anything active rather than trying to clean it.
export function isSafeSvg(content: string): boolean {
  return !/<script|<foreignObject|\son[a-z]+\s*=|javascript:|<!ENTITY|xlink:href\s*=\s*["']\s*(?!#)|href\s*=\s*["']\s*(?!#|data:image\/)/i.test(
    content,
  );
}

// Keeps names readable in storage keys and headers; the original is kept in the DB.
export function safeFilename(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, '-')
    .replace(/^[.\-]+/, '')
    .slice(-120);
  return cleaned || 'file';
}
