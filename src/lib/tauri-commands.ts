import { invoke } from "@tauri-apps/api/core";
import type { ConnectionConfig, QueryResult, ExecuteResult, TableInfo, ColumnInfo, ConnectionHealth } from "@/stores/app-store";

// Check if we're running in Tauri environment
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Wrapper for invoke that checks Tauri environment first
async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) {
    throw new Error("This app must be run in a Tauri environment. Please use the desktop app instead of the browser.");
  }
  return invoke<T>(cmd, args);
}

export async function connectDatabase(config: ConnectionConfig): Promise<string> {
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
    sslEnabled: config.sslEnabled,
    keepaliveInterval: config.keepaliveInterval || 30,
    autoReconnect: config.autoReconnect !== false
  };
  return safeInvoke<string>("connect_to_database", { config: backendConfig });
}

export async function disconnectDatabase(id: string): Promise<void> {
  return safeInvoke<void>("disconnect_database", { id });
}

export async function executeQuery(id: string, sql: string): Promise<QueryResult> {
  const raw = await safeInvoke<any>("execute_query", { id, sql });
  
  // Map camelCase from Rust to our frontend format
  return {
    columns: (raw.columns || []).map((c: any) => ({
      name: c.name,
      dataType: c.dataType,
      nullable: c.nullable,
      isPrimaryKey: c.isPrimaryKey,
    })),
    rows: (raw.rows || []).map((row: any) => {
      const newRow: Record<string, any> = {};
      for (const [key, value] of Object.entries(row)) {
        // 确保所有类型的数据都能被正确处理
        if (value === null || value === undefined) {
          newRow[key] = "";
        } else {
          newRow[key] = String(value);
        }
      }
      return newRow;
    }),
    rowCount: raw.rowCount ?? 0,
    executionTime: raw.executionTimeMs ?? 0,
  };
}

export async function executeSql(id: string, sql: string): Promise<ExecuteResult> {
  const raw = await safeInvoke<any>("execute_sql", { id, sql });
  return {
    success: true,
    message: `${raw.rowsAffected ?? 0} rows affected`,
    affectedRows: raw.rowsAffected ?? 0,
    executionTime: raw.executionTimeMs ?? 0,
  };
}

export async function getTables(id: string): Promise<TableInfo[]> {
  const raw = await safeInvoke<any[]>("get_tables", { id });
  return raw.map((t: any) => ({
    name: t.name,
    schema: t.schema,
    type: (t.tableType || "table").toLowerCase() as "table" | "view",
  }));
}

export async function getColumns(id: string, table: string, schema?: string): Promise<ColumnInfo[]> {
  const raw = await safeInvoke<any[]>("get_columns", { id, table, schema });
  return raw.map((c: any) => ({
    name: c.name,
    dataType: c.dataType,
    nullable: c.nullable,
    isPrimaryKey: c.isPrimaryKey,
  }));
}

export async function getSchemas(id: string): Promise<string[]> {
  return safeInvoke<string[]>("get_schemas", { id });
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
    sslEnabled: config.sslEnabled,
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
    healthy: raw.healthy ?? true,
    reconnectCount: raw.reconnectCount ?? 0,
    lastHeartbeat: raw.lastHeartbeat ?? "",
  };
}
