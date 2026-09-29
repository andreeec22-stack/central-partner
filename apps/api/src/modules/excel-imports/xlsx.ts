import ExcelJS from 'exceljs';
import { validationError } from '../../lib/errors';

export const MAX_IMPORT_ROWS = 1000;
const MAX_COLUMNS = 30;

// First worksheet → rows of display text. Dates become ISO strings, formulas
// their cached result, rich text its plain text.
export async function readSheet(bytes: Uint8Array): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  } catch {
    throw validationError('This file could not be read as an Excel workbook (.xlsx)', [{ field: 'file', message: 'unreadable' }]);
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw validationError('The workbook has no sheets', [{ field: 'file', message: 'empty' }]);

  const rows: string[][] = [];
  let nonEmpty = 0;
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const cells: string[] = [];
    for (let col = 1; col <= Math.min(row.cellCount, MAX_COLUMNS); col++) {
      const cell = row.getCell(col);
      const value = cell.value;
      if (value instanceof Date) cells.push(value.toISOString().slice(0, 10));
      else if (value && typeof value === 'object' && 'result' in value && value.result instanceof Date) {
        cells.push(value.result.toISOString().slice(0, 10));
      } else cells.push((cell.text ?? '').toString());
    }
    rows[rowNumber - 1] = cells;
    if (cells.some((c) => c.trim())) nonEmpty++;
  });
  // +1: a header row doesn't count against the limit.
  if (nonEmpty > MAX_IMPORT_ROWS + 1) {
    throw validationError(`An import can have at most ${MAX_IMPORT_ROWS} rows (this file has ${nonEmpty})`, [
      { field: 'file', message: 'too many rows' },
    ]);
  }
  return Array.from(rows, (r) => r ?? []);
}
