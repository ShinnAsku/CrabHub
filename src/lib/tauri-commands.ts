import { invoke } from "@tauri-apps/api/core";
import type { ConnectionConfig, QueryResult, PagedQueryResult, ExecuteResult, TableInfo, ColumnInfo, ConnectionHealth } from "@/types";
import { getPassword } from "./secure-storage";
import { isMockMode, mockInvoke } from "./tauri-commands-mock";

// Update types
export interface UpdateStatus {
  available: boolean;
  version: string;
  date: string;
  body: string;
  url: string;
}

// Check if we're running in Tauri environment
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Wrapper for invoke that checks Tauri environment first
async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isMockMode()) {
    return mockInvoke<T>(cmd, args);
  }
  if (!isTauri) {
    throw new Error("This app must be run in a Tauri environment. Please use the desktop app instead of the browser.");
  }
  return invoke<T>(cmd, args);
}

export interface ConnectResult {
  connectionId: string;
  detectedType: string;
}

export async function connectDatabase(config: ConnectionConfig): Promise<ConnectResult> {
  // Get password from secure storage if not provided
  let password = config.password;
  if (!password && config.id) {
    const storedPassword = await getPassword(config.id);
    if (storedPassword) {
      password = storedPassword;
    }
  }
  
  // Convert frontend ConnectionConfig to backend format (camelCase)
  const backendConfig = {
    id: config.id || crypto.randomUUID(),
    name: config.name,
    dbType: config.type,
    host: config.host || undefined,
    port: config.port || undefined,
    username: config.username || undefined,
    password: password || undefined,
    database: config.database || undefined,
    sslEnabled: config.enableSsl || false,
    keepaliveInterval: config.keepaliveInterval || 30,
    autoReconnect: config.autoReconnect !== false
  };
  return safeInvoke<ConnectResult>("connect_to_database", { config: backendConfig });
}

export async function disconnectDatabase(id: string): Promise<void> {
  return safeInvoke<void>("disconnect_database", { id });
}

export async function executeQuery(id: string, sql: string): Promise<QueryResult> {
  const raw = await safeInvoke<any>("execute_query", { id, sql });
  return mapRawQueryResult(raw);
}

export async function executeQueryPaged(id: string, sql: string, limit: number, offset: number): Promise<PagedQueryResult> {
  const raw = await safeInvoke<any>("execute_query_paged", { id, sql, limit, offset });
  return {
    ...mapRawQueryResult(raw),
    hasMore: raw.hasMore ?? false,
  };
}

// Helper: map raw backend query result to frontend format
function mapRawQueryResult(raw: any): QueryResult {
  const columns = (raw.columns || []).map((c: any) => ({
    name: c.name,
    dataType: c.dataType,
    nullable: c.nullable,
    isPrimaryKey: c.isPrimaryKey,
  }));
  
  // Helper function to get the actual value from serde_json::Value
  const getActualValue = (value: any): any => {
    if (value === null || value === undefined) {
      return "";
    }
    
    // Check if value is a serde_json::Value object
    if (typeof value === 'object' && value !== null) {
      // Check for serde_json::Value types
      if (value.hasOwnProperty('type') && value.hasOwnProperty('value')) {
        // This is a serde_json::Value wrapper
        return getActualValue(value.value);
      }
      
      // Check if it's a string value
      if (value.hasOwnProperty('String')) {
        return value.String;
      }
      
      // Check if it's a number value
      if (value.hasOwnProperty('Number')) {
        return value.Number;
      }
      
      // Check if it's a boolean value
      if (value.hasOwnProperty('Bool')) {
        return value.Bool;
      }
    }
    
    return value;
  };
  
  // Map camelCase from Rust to our frontend format
  return {
    columns,
    rows: (raw.rows || []).map((row: any) => {
      const newRow: Record<string, any> = {};
      
      // Check if row is an array (index-based) or object (key-based)
      if (Array.isArray(row) && columns.length > 0) {
        // Array-based rows (common in some database drivers)
        row.forEach((value: any, index: number) => {
          if (index < columns.length) {
            const columnName = columns[index].name;
            newRow[columnName] = getActualValue(value);
          }
        });
      } else {
        // Object-based rows
        for (const [key, value] of Object.entries(row)) {
          newRow[key] = getActualValue(value);
        }
      }
      
      return newRow;
    }),
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
  // Convert frontend ConnectionConfig to backend format (camelCase)
  const backendConfig = {
    id: config.id || crypto.randomUUID(),
    name: config.name,
    dbType: config.type,
    host: config.host || undefined,
    port: config.port || undefined,
    username: config.username || undefined,
    password: config.password || undefined,
    database: config.database || undefined,
    sslEnabled: config.enableSsl || false,
    keepaliveInterval: config.keepaliveInterval || 30,
    autoReconnect: config.autoReconnect !== false
  };
  try {
    return await safeInvoke<boolean>("test_connection_cmd", { config: backendConfig });
  } catch (error) {
    console.error("Connection test error:", error);
    throw error;
  }
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
  whereClause: string,
  schema?: string
): Promise<ExecuteResult> {
  const raw = await safeInvoke<any>("update_table_rows", {
    id,
    table,
    schema: schema ?? null,
    updates,
    where_clause: whereClause,
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
  whereClause: string,
  schema?: string
): Promise<ExecuteResult> {
  const raw = await safeInvoke<any>("delete_table_rows", {
    id,
    table,
    schema: schema ?? null,
    where_clause: whereClause,
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
  const raw = await safeInvoke<any>("get_table_data", {
    id,
    table,
    schema: schema ?? null,
    page,
    pageSize,
    orderBy: orderBy ?? null,
  });

  const columns = (raw.columns || []).map((c: any) => ({
    name: c.name,
    dataType: c.dataType,
    nullable: c.nullable,
    isPrimaryKey: c.isPrimaryKey,
  }));

  return {
    columns,
    rows: (raw.rows || []).map((row: any) => {
      const newRow: Record<string, any> = {};
      for (const [key, value] of Object.entries(row)) {
        newRow[key] = value;
      }
      return newRow;
    }),
    rowCount: raw.rowCount ?? 0,
    duration: raw.executionTimeMs ?? 0,
  };
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

export async function installUpdate(): Promise<void> {
  return safeInvoke<void>("updater:install");
}
