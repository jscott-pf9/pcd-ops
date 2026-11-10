import * as XLSX from "xlsx";
import type { Cell } from "../pages/inventory/exports";

export interface SheetData { name: string; headers: string[]; rows: Cell[][] }

/** Save sheets as one Excel workbook. Sheet names are cut to Excel's 31 characters. */
export function downloadWorkbook(filename: string, sheets: SheetData[]) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([s.headers, ...s.rows]), s.name.slice(0, 31));
  }
  XLSX.writeFile(wb, filename);
}
