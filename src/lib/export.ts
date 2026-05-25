import Papa from "papaparse";
import type { ColumnInfo } from "@/types";

/**
 * Export query results to CSV format
 */
export function exportToCSV(columns: ColumnInfo[], rows: any[]): string {
  const headers = columns.map((c) => c.name);
  const data = rows.map((row) =>
    columns.map((col) => {
      const val = row[col.name];
      if (val === null || val === undefined) return "";
      return String(val);
    })
  );
  return Papa.unparse({
    fields: headers,
    data,
  });
}

/**
 * Export query results to JSON format
 */
export function exportToJSON(columns: ColumnInfo[], rows: any[]): string {
  return JSON.stringify(
    rows.map((row) => {
      const obj: Record<string, any> = {};
      for (const col of columns) {
        obj[col.name] = row[col.name] ?? null;
      }
      return obj;
    }),
    null,
    2
  );
}

/**
 * Export query results to SQL INSERT statements
 */
export function exportToSQL(
  columns: ColumnInfo[],
  rows: any[],
  tableName: string
): string {
  if (rows.length === 0) return "";

  const colNames = columns.map((c) => c.name).join(", ");
  const statements: string[] = [];

  for (const row of rows) {
    const values = columns.map((col) => {
      const val = row[col.name];
      if (val === null || val === undefined) return "NULL";
      if (typeof val === "number") return String(val);
      if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
      // Escape single quotes
      return `'${String(val).replace(/'/g, "''")}'`;
    });
    statements.push(`INSERT INTO ${tableName} (${colNames}) VALUES (${values.join(", ")});`);
  }

  return statements.join("\n");
}

/**
 * Trigger file download using browser fallback or Tauri dialog
 */
export async function downloadFile(
  content: string,
  filename: string,
  mimeType: string
): Promise<void> {
  // Try Tauri dialog first
  const isTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  if (isTauri) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const filePath = await save({
        defaultPath: filename,
        filters: [{ name: filename.split(".").pop() || "File", extensions: [filename.split(".").pop() || "*"] }],
      });
      if (filePath) {
        await writeTextFile(filePath, content);
        return;
      }
    } catch {
      // Fall through to browser download
    }
  }

  // Browser fallback
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Import data from a CSV file
 */
export function importFromCSV(file: File): Promise<{ columns: string[]; rows: any[] }> {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const columns = results.meta.fields || [];
        const rows = results.data as any[];
        resolve({ columns, rows });
      },
      error: (err: Error) => {
        reject(err);
      },
    });
  });
}

/**
 * Import data from a JSON file
 */
export async function importFromJSON(file: File): Promise<{ columns: string[]; rows: any[] }> {
  const text = await file.text();
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data : [data];
  if (arr.length === 0) {
    return { columns: [], rows: [] };
  }
  const columns = Object.keys(arr[0]);
  return { columns, rows: arr };
}

/**
 * Build a WHERE clause for UPDATE/DELETE operations.
 * Uses primary key columns if available, otherwise falls back to all columns.
 *
 * SECURITY: This SQL-string variant is intended for displaying / generating
 * editable SQL (e.g. the "Generate DELETE SQL" feature that pastes into the
 * editor). For actual execution use `buildWhereConditions` and pass the result
 * to `updateTableRows` / `deleteTableRows` — the structured form is parameterized
 * at the IPC boundary and cannot be SQL-injected.
 */
export function buildWhereClause(
  columns: { name: string; isPrimaryKey?: boolean }[],
  row: Record<string, any>
): string {
  const pkCols = columns.filter((c) => c.isPrimaryKey);
  const targetCols = pkCols.length > 0 ? pkCols : columns;

  const conditions = targetCols.map((col) => {
    const val = row[col.name];
    if (val === null || val === undefined) {
      return `${col.name} IS NULL`;
    }
    if (typeof val === "number" || typeof val === "bigint") {
      return `${col.name} = ${val}`;
    }
    if (typeof val === "boolean") {
      return `${col.name} = ${val ? "TRUE" : "FALSE"}`;
    }
    return `${col.name} = '${String(val).replace(/'/g, "''")}'`;
  });

  return conditions.join(" AND ");
}

/**
 * Build structured WHERE conditions for safe row-level UPDATE/DELETE.
 * Prefer this over `buildWhereClause` for anything that actually executes.
 */
export function buildWhereConditions(
  columns: { name: string; isPrimaryKey?: boolean }[],
  row: Record<string, any>
): { column: string; value: unknown }[] {
  const pkCols = columns.filter((c) => c.isPrimaryKey);
  const targetCols = pkCols.length > 0 ? pkCols : columns;
  return targetCols.map((col) => ({
    column: col.name,
    value: row[col.name] ?? null,
  }));
}

/**
 * Generate a copy table name like "table_copy1", "table_copy2", etc.
 * Checks existing table names to find the next available number.
 */
export function generateCopyTableName(originalName: string, existingNames: string[]): string {
  const lowerNames = new Set(existingNames.map(n => n.toLowerCase()));
  let i = 1;
  while (true) {
    const candidate = `${originalName}_copy${i}`;
    if (!lowerNames.has(candidate.toLowerCase())) {
      return candidate;
    }
    i++;
  }
}

/**
 * Build SQL statements for duplicating a table.
 * Returns an array of SQL strings to execute in order.
 * For databases needing DDL-based approach, pass the DDL string.
 */
export function buildDuplicateTableSQL(
  dbType: string,
  oldName: string,
  newName: string,
  schema: string | undefined,
  includeData: boolean,
  ddl?: string,
): string[] {
  const sqls: string[] = [];

  if (dbType === 'postgresql' || dbType === 'gaussdb' || dbType === 'opengauss') {
    const oldFull = schema ? `"${schema}"."${oldName}"` : `"${oldName}"`;
    const newFull = schema ? `"${schema}"."${newName}"` : `"${newName}"`;
    sqls.push(`CREATE TABLE ${newFull} (LIKE ${oldFull} INCLUDING ALL)`);
    if (includeData) {
      sqls.push(`INSERT INTO ${newFull} SELECT * FROM ${oldFull}`);
    }
  } else if (dbType === 'mysql') {
    const oldFull = `\`${oldName}\``;
    const newFull = `\`${newName}\``;
    sqls.push(`CREATE TABLE ${newFull} LIKE ${oldFull}`);
    if (includeData) {
      sqls.push(`INSERT INTO ${newFull} SELECT * FROM ${oldFull}`);
    }
  } else if (dbType === 'sqlite') {
    if (includeData) {
      sqls.push(`CREATE TABLE "${newName}" AS SELECT * FROM "${oldName}"`);
    } else {
      if (ddl) {
        const replaced = ddl.replace(
          /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?("[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)/i,
          `CREATE TABLE "${newName}"`
        );
        sqls.push(replaced);
      }
    }
  } else if (dbType === 'mssql') {
    if (includeData) {
      const oldFull = schema ? `[${schema}].[${oldName}]` : `[${oldName}]`;
      const newFull = schema ? `[${schema}].[${newName}]` : `[${newName}]`;
      sqls.push(`SELECT * INTO ${newFull} FROM ${oldFull}`);
    } else {
      if (ddl) {
        const replaced = ddl.replace(
          /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?("[^"]+"|`[^`]+`|\[[^\]]+\]\.?\[[^\]]+\]|\S+)/i,
          schema ? `CREATE TABLE [${schema}].[${newName}]` : `CREATE TABLE [${newName}]`
        );
        sqls.push(replaced);
      }
    }
  } else {
    // ClickHouse and others: DDL-based approach
    if (ddl) {
      const replaced = ddl.replace(
        /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?("[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)/i,
        `CREATE TABLE "${newName}"`
      );
      sqls.push(replaced);
    }
    if (includeData) {
      const oldFull = schema ? `"${schema}"."${oldName}"` : `"${oldName}"`;
      const newFull = schema ? `"${schema}"."${newName}"` : `"${newName}"`;
      sqls.push(`INSERT INTO ${newFull} SELECT * FROM ${oldFull}`);
    }
  }

  return sqls;
}
