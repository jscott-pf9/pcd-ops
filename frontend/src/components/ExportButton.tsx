import { Download } from "lucide-react";
import { type Cell, downloadCsv } from "../pages/inventory/exports";

/** "Export CSV" for the rows a page shows; `rows` is called on click. */
export default function ExportButton({ filename, headers, rows, label = "Export CSV" }: {
  filename: string; headers: string[]; rows: () => Cell[][]; label?: string;
}) {
  return (
    <button type="button" className="btn btn-secondary btn-sm" onClick={() => downloadCsv(filename, headers, rows())}
      style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <Download size={12} /> {label}
    </button>
  );
}
