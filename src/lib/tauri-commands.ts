import type { ConnectionConfig, QueryResult, PagedQueryResult, ExecuteResult, TableInfo, ColumnInfo, ConnectionHealth } from "@/types/index";
import { getPassword } from "@/lib/secure-storage";
import { toRuntimeConnection } from "@/features/connections/profile";
import { transportInvoke as safeInvoke } from "@/lib/transport";
export { transportInvoke } from "@/lib/transport";

/**
 * Structured WHERE condition for row-level UPDATE/DELETE. Multiple conditions
 * are AND-joined with equality semantics (or `IS NULL` when value is null).
 * This shape eliminates SQL-injection risk at the IPC boundary — the frontend
 * cannot send an arbitrary WHERE string.
 */
export interface WhereCondition {
  column: string;
  value: unknown;
}

// Update types
export interface UpdateStatus {
  available: boolean;
  version: string;
  date: string;
  body: string;
  url: string;
}

export interface ConnectResult {
  connectionId: string;
  detectedType: string;
}

async function resolveRuntimeConnection(config: ConnectionConfig) {
  let password = config.password;
  if (password == null && config.id) {
    const storedPassword = await getPassword(config.id);
    if (storedPassword) {
      password = storedPassword;
    }
  }
  
  return toRuntimeConnection({ ...config, password });
}

export async function connectDatabase(config: ConnectionConfig): Promise<ConnectResult> {
  return safeInvoke<ConnectResult>("connect_to_database", { config: await resolveRuntimeConnection(config) });
}

export async function disconnectDatabase(id: string): Promise<void> {
  return safeInvoke<void>("disconnect_database", { id });
}

export async function switchDatabase(id: string, database: string): Promise<void> {
  return safeInvoke<void>("switch_database", { id, database });
}

export async function executeQuery(id: string, sql: string): Promise<QueryResult> {
  const raw = await safeInvoke<RawQueryResult>("execute_query", { id, sql });
  return mapRawQueryResult(raw);
}

export async function executeBatch(id: string, statements: string[]): Promise<BatchResultItem[]> {
  const raw = await safeInvoke<RawBatchItem[]>("execute_batch", { id, statements });
  return raw.map(mapRawBatchResult);
}

export function mapRawBatchResult(raw: RawBatchItem): BatchResultItem {
  if ("type" in raw) return { ...raw, duration: raw.executionTimeMs ?? 0 };
  if ("columns" in raw) {
    return { ...mapRawQueryResult(raw), hasMore: raw.hasMore ?? false };
  }
  const rowsAffected = "rowsAffected" in raw ? raw.rowsAffected ?? 0 : 0;
  return {
    success: true,
    rowsAffected,
    message: `${rowsAffected} rows affected`,
    duration: raw.executionTimeMs ?? 0,
  };
}

export async function executeQueryPaged(id: string, sql: string, limit: number, offset: number): Promise<PagedQueryResult> {
  const raw = await safeInvoke<RawQueryResult>("execute_query_paged", { id, sql, limit, offset });
  return {
    ...mapRawQueryResult(raw),
    hasMore: raw.hasMore ?? false,
  };
}

// ---------------------------------------------------------------------------
// Raw IPC shapes (mirror serde-camelCase output from the Rust backend).
// ---------------------------------------------------------------------------

interface RawColumn {
  name: string;
  dataType: string;
  nullable?: boolean;
  isPrimaryKey?: boolean;
}

type RawCell = string | number | boolean | null | Record<string, unknown> | unknown[];
type RawRow = RawCell[] | Record<string, RawCell>;

interface RawQueryResult {
  columns?: RawColumn[];
  rows?: RawRow[];
  rowCount?: number;
  executionTimeMs?: number;
  hasMore?: boolean;
}

type RawBatchItem =
  | RawQueryResult
  | { type: "error"; message: string; executionTimeMs?: number }
  | { type: "empty"; executionTimeMs?: number }
  | { rowsAffected?: number; executionTimeMs?: number };

export interface BatchResultItem {
  /** Discriminator when the row carries no result set ("error" / "empty"). */
  type?: "error" | "empty";
  message?: string;
  // QueryResult shape (set when the statement returned rows).
  columns?: QueryResult["columns"];
  rows?: QueryResult["rows"];
  rowCount?: number;
  duration?: number;
  hasMore?: boolean;
  // ExecuteResult shape (set when the statement did not return rows).
  rowsAffected?: number;
  success?: boolean;
  error?: string;
}

// Helper: map raw backend query result to frontend format.
// Exported for unit tests — this is the single funnel every query result
// passes through (object rows from legacy paths, array rows from wire types).
export function mapRawQueryResult(raw: RawQueryResult): QueryResult {
  const columns = (raw.columns || []).map((c) => ({
    name: c.name,
    dataType: c.dataType,
    nullable: c.nullable,
    isPrimaryKey: c.isPrimaryKey,
  })) as unknown as QueryResult["columns"];

  // Tauri v2 serializes serde_json::Value as plain JSON — no wrapper unwrapping needed.
  // null stays null for SQL NULL display; empty string would lose the distinction.
  const rows = (raw.rows || []).map((row) => {
    if (Array.isArray(row) && columns.length > 0) {
      const mapped: Record<string, RawCell> = {};
      row.forEach((value, index) => {
        const col = columns[index];
        if (col) {
          mapped[col.name] = value;
        }
      });
      return mapped;
    }
    return { ...(row as Record<string, RawCell>) };
  });

  return {
    columns,
    rows,
    rowCount: raw.rowCount ?? 0,
    duration: raw.executionTimeMs ?? 0,
  };
}

export async function executeSql(id: string, sql: string): Promise<ExecuteResult> {
  const raw = await safeInvoke<any>("execute_sql", { id, sql });
  return {
    success: true,
    message: `${raw.rowsAffected ?? 0} rows affected`,

    duration: raw.executionTimeMs ?? 0,
  };
}

export async function getTables(id: string): Promise<TableInfo[]> {
  const raw = await safeInvoke<any[]>("get_tables", { id });
  return raw.map((t: any) => ({
    oid: t.oid ?? null,
    name: t.name,
    schema: t.schema ?? "",
    owner: t.owner ?? null,
    size: "",
    description: t.comment ?? "",
    acl: t.acl ?? null,
    tablespace: "",
    hasIndexes: t.hasIndexes ?? null,
    hasRules: false,
    hasTriggers: t.hasTriggers ?? null,
    rowCount: t.rowCount ?? null,
    primaryKey: t.primaryKey ?? null,
    partitionOf: t.partitionOf ?? null,
    tableType: t.tableType ?? "TABLE",
    created: new Date(),
    modified: new Date(),
    // MySQL fields
    engine: t.engine ?? null,
    dataLength: t.dataLength ?? null,
    createTime: t.createTime ?? null,
    updateTime: t.updateTime ?? null,
    collation: t.collation ?? null,
  }));
}

export async function getColumns(id: string, table: string, schema?: string): Promise<ColumnInfo[]> {
  const raw = await safeInvoke<any[]>("get_columns", { id, table, schema });
  return raw.map((c: any) => ({
    name: c.name,
    type: c.dataType,
    length: c.characterMaximumLength ?? null,
    precision: c.numericPrecision ?? null,
    scale: c.numericScale ?? null,
    notNull: !c.nullable,
    defaultValue: c.defaultValue || null,
    description: c.comment || "",
    primaryKey: c.isPrimaryKey,
    unique: false,
  }));
}

export async function getSchemas(id: string): Promise<string[]> {
  return safeInvoke<string[]>("get_schemas", { id });
}

export async function getDatabases(id: string): Promise<string[]> {
  return safeInvoke<string[]>("get_databases", { id });
}

export async function getSchemasForDatabase(id: string, databaseName: string): Promise<string[]> {
  return safeInvoke<string[]>("get_schemas_for_database", { id, databaseName });
}

export async function testConnection(config: ConnectionConfig): Promise<boolean> {
  return safeInvoke<boolean>("test_connection_cmd", { config: await resolveRuntimeConnection(config) });
}

export async function exportDatabase(id: string, tables?: string[]): Promise<string> {
  return safeInvoke<string>("export_database", { id, tables: tables ?? null });
}

export async function exportTableSql(id: string, table: string, schema?: string): Promise<string> {
  return safeInvoke<string>("export_table_sql", { id, table, schema: schema ?? null });
}

export async function getConnectionStatus(id: string): Promise<ConnectionHealth> {
  const raw = await safeInvoke<any>("get_connection_status", { id });
  return {
    status: raw.healthy ? 'healthy' : 'unhealthy',
    lastChecked: new Date(),
  };
}

// ============================================================================
// New metadata query commands
// ============================================================================

export async function getViews(id: string, schema?: string): Promise<TableInfo[]> {
  const raw = await safeInvoke<any[]>("get_views", { id, schema: schema ?? null });
  return raw.map((t: any) => ({
    oid: t.oid ?? null,
    name: t.name,
    schema: t.schema ?? "",
    owner: t.owner ?? null,
    size: "",
    description: t.comment ?? "",
    acl: t.acl ?? null,
    tablespace: "",
    hasIndexes: t.hasIndexes ?? null,
    hasRules: false,
    hasTriggers: t.hasTriggers ?? null,
    rowCount: t.rowCount ?? null,
    primaryKey: t.primaryKey ?? null,
    partitionOf: t.partitionOf ?? null,
    tableType: t.tableType ?? "VIEW",
    created: new Date(),
    modified: new Date(),
    // MySQL fields
    engine: t.engine ?? null,
    dataLength: t.dataLength ?? null,
    createTime: t.createTime ?? null,
    updateTime: t.updateTime ?? null,
    collation: t.collation ?? null,
  }));
}

export async function getTableIndexes(id: string, table: string, schema?: string): Promise<any[]> {
  return safeInvoke<any[]>("get_indexes", { id, table, schema: schema ?? null });
}

export async function getTableForeignKeys(id: string, table: string, schema?: string): Promise<any[]> {
  return safeInvoke<any[]>("get_foreign_keys", { id, table, schema: schema ?? null });
}

export async function getTableRowCount(id: string, table: string, schema?: string): Promise<number> {
  return safeInvoke<number>("get_table_row_count", { id, table, schema: schema ?? null });
}

// ============================================================================
// New data editing commands
// ============================================================================

export async function updateTableRows(
  id: string,
  table: string,
  updates: [string, any][],
  whereConditions: WhereCondition[],
  schema?: string
): Promise<ExecuteResult> {
  const raw = await safeInvoke<any>("update_table_rows", {
    id,
    table,
    schema: schema ?? null,
    updates,
    whereConditions,
  });
  return {
    success: true,
    message: `${raw.rowsAffected ?? 0} rows affected`,
    duration: raw.executionTimeMs ?? 0,
  };
}

export async function insertTableRow(
  id: string,
  table: string,
  values: [string, any][],
  schema?: string
): Promise<ExecuteResult> {
  const raw = await safeInvoke<any>("insert_table_row", {
    id,
    table,
    schema: schema ?? null,
    values,
  });
  return {
    success: true,
    message: `${raw.rowsAffected ?? 0} rows affected`,
    duration: raw.executionTimeMs ?? 0,
  };
}

export async function deleteTableRows(
  id: string,
  table: string,
  whereConditions: WhereCondition[],
  schema?: string
): Promise<ExecuteResult> {
  const raw = await safeInvoke<any>("delete_table_rows", {
    id,
    table,
    schema: schema ?? null,
    whereConditions,
  });
  return {
    success: true,
    message: `${raw.rowsAffected ?? 0} rows affected`,
    duration: raw.executionTimeMs ?? 0,
  };
}

export async function getTableData(
  id: string,
  table: string,
  page: number = 1,
  pageSize: number = 100,
  orderBy?: string,
  schema?: string
): Promise<QueryResult> {
  const raw = await safeInvoke<RawQueryResult>("get_table_data", {
    id,
    table,
    schema: schema ?? null,
    page,
    pageSize,
    orderBy: orderBy ?? null,
  });
  return mapRawQueryResult(raw);
}

// ---------------------------------------------------------------------------
// Streaming export (Rust-side, memory-flat, no MAX_DISPLAY_ROWS cap)
// ---------------------------------------------------------------------------

export type StreamExportFormat = "csv" | "json" | "sql" | "xlsx";

export interface ExportSummary {
  rowsWritten: number;
  filePath: string;
  cancelled: boolean;
}

/**
 * Stream a query's FULL result set to a file on the Rust side.
 * Progress is emitted via `export-progress` events carrying
 * `{ exportId, rowsWritten, done }`.
 */
export async function exportQueryToFile(
  id: string,
  sql: string,
  format: StreamExportFormat,
  filePath: string,
  exportId: string,
  tableName?: string
): Promise<ExportSummary> {
  return safeInvoke<ExportSummary>("export_query_to_file", {
    id,
    sql,
    format,
    filePath,
    exportId,
    tableName: tableName ?? null,
  });
}

/** Request cancellation of a running export (takes effect between batches). */
export async function cancelExport(exportId: string): Promise<void> {
  return safeInvoke<void>("cancel_export", { exportId });
}

/** Drop the backend's cached schema metadata for a connection (used by refresh). */
export async function invalidateMetadataCache(id: string): Promise<void> {
  return safeInvoke<void>("invalidate_metadata_cache", { id });
}

// Driver discovery
export interface DriverTypeInfo {
  id: string;
  name: string;
  builtin: boolean;
}

export async function getAvailableDrivers(): Promise<DriverTypeInfo[]> {
  return safeInvoke<DriverTypeInfo[]>("get_available_drivers");
}

// Plugin commands
export async function fetchPluginRegistry(): Promise<any> {
  return safeInvoke<any>("fetch_plugin_registry");
}

export async function listPlugins(): Promise<any> {
  return safeInvoke<any>("list_plugins");
}

export async function installPlugin(pluginId: string, version: string): Promise<void> {
  return safeInvoke<void>("install_plugin", { pluginId, version });
}

export async function removePlugin(pluginId: string): Promise<void> {
  return safeInvoke<void>("remove_plugin", { pluginId });
}

export async function enablePlugin(pluginId: string): Promise<void> {
  return safeInvoke<void>("enable_plugin", { pluginId });
}

export async function disablePlugin(pluginId: string): Promise<void> {
  return safeInvoke<void>("disable_plugin", { pluginId });
}

// Update commands
export async function checkForUpdates(): Promise<UpdateStatus> {
  return safeInvoke<UpdateStatus>("updater:check");
}

export async function cancelQuery(id: string): Promise<boolean> {
  return safeInvoke<boolean>("cancel_query", { id });
}

export interface DriverCapabilities {
  supportsScriptSessions?: boolean;
  supportsInteractiveTransactions?: boolean;
  supportsSchemas: boolean;
  supportsManageTables: boolean;
  supportsViews: boolean;
  supportsProcedures: boolean;
  supportsTriggers: boolean;
  isFileBased: boolean;
  supportsIndexes: boolean;
  supportsForeignKeys: boolean;
  supportsPartitions: boolean;
  supportsCancel: boolean;
  identifierQuote: string;
  defaultPort: number;
}

export async function getDriverCapabilities(id: string): Promise<DriverCapabilities> {
  return safeInvoke<DriverCapabilities>("get_driver_capabilities", { id });
}

export async function installUpdate(): Promise<void> {
  return safeInvoke<void>("updater:install");
}
