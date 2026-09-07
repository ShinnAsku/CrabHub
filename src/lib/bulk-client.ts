import { transportInvoke } from "@/lib/tauri-commands";

export interface BulkTarget {
  id: string;
  table: string;
  schema?: string;
  columns: string[];
}

interface BulkOutcome {
  executionId: string;
  committedRows: number | null;
  completedRows: number;
  failedRowOffset: number | null;
  transaction: "native" | "committed" | "rolledBack" | "unknown";
  error: string | null;
}

export function supportsBulkWrite(id: string): Promise<boolean> {
  return transportInvoke<boolean>("supports_script_sessions", { id }).catch(() => false);
}

export async function insertRowsBulk(target: BulkTarget, rows: unknown[][], atomic: boolean): Promise<number> {
  if (rows.length === 0) return 0;
  const request = { ...target, executionId: crypto.randomUUID(), rows, atomic };
  if (rows.length > 10_000 || new TextEncoder().encode(JSON.stringify(request)).byteLength > 1024 * 1024) {
    throw new Error("Bulk request exceeds 10000 rows or 1 MiB; reduce the batch size");
  }
  const result = await transportInvoke<BulkOutcome>("insert_rows_bulk", { request });
  if (result.error || result.committedRows === null || result.committedRows !== rows.length) {
    const committed = result.committedRows === null ? "unknown" : String(result.committedRows);
    throw new Error(`${result.error ?? "Incomplete bulk write"}; committed rows: ${committed}; chunk offset: ${result.failedRowOffset ?? "unknown"}. Do not retry the entire import automatically.`);
  }
  return result.committedRows;
}

export async function importRowsBatched(target: BulkTarget, rows: Record<string, unknown>[]): Promise<number> {
  let committed = 0;
  let chunk: unknown[][] = [];
  let bytes = new TextEncoder().encode(JSON.stringify(target)).byteLength;
  const flush = async () => {
    if (chunk.length === 0) return;
    committed += await insertRowsBulk(target, chunk, false);
    chunk = [];
    bytes = new TextEncoder().encode(JSON.stringify(target)).byteLength;
  };
  try {
    for (const row of rows) {
      const values = target.columns.map(column => row[column] ?? null);
      const rowBytes = new TextEncoder().encode(JSON.stringify(values)).byteLength + 1;
      if (rowBytes > 900_000) throw new Error("A single row exceeds the import request budget");
      if (chunk.length >= 500 || bytes + rowBytes > 900_000) await flush();
      chunk.push(values);
      bytes += rowBytes;
    }
    await flush();
    return committed;
  } catch (error) {
    throw new Error(`Previously completed batches committed ${committed} rows. ${String(error)}`);
  }
}
